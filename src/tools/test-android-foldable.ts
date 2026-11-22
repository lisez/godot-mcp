import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CallToolResult, ImageContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { execFileAsync } from '../process.ts';
import { jsonResult, runCommand } from '../tool-runtime.ts';

export const definition: Tool = {
  name: 'test_android_foldable',
  description: 'Install and launch an APK once on a running foldable emulator. Capture the focused app window bounds, committed posture, available hinge geometry, Activity events, app logs and a display screenshot at each step.',
  inputSchema: {
    type: 'object',
    properties: {
      apkPath: { type: 'string', description: 'Path to the APK on the server.' },
      emulatorSerial: { type: 'string', pattern: '^emulator-[0-9]+$', description: 'ADB serial of the running Android emulator.' },
      states: { type: 'array', minItems: 1, items: { type: 'string', enum: ['folded', 'unfolded'] } },
    },
    required: ['apkPath', 'emulatorSerial', 'states'],
  },
};

type State = 'folded' | 'unfolded';
type Adb = (...args: string[]) => Promise<string>;
const busy = new Set<string>();

async function sdkExecutable(name: 'aapt' | 'adb') {
  const file = process.platform === 'win32' ? name + '.exe' : name;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) return file;
  if (name === 'adb') {
    const path = join(sdk, 'platform-tools', file);
    if (existsSync(path)) return path;
  } else {
    const buildTools = join(sdk, 'build-tools');
    if (existsSync(buildTools)) {
      const versions = (await readdir(buildTools)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const version of versions) {
        const path = join(buildTools, version, file);
        if (existsSync(path)) return path;
      }
    }
  }
  return file;
}

async function checked(file: string, args: string[]) {
  const { stdout, stderr, exitCode, timedOut } = await runCommand(file, args, { timeoutMs: 30_000 });
  if (timedOut || exitCode !== 0 || /^(?:KO\b|Error:|Failure\s*\[)/m.test(stdout)) {
    throw new Error(`${file} ${args.join(' ')}: ${timedOut ? 'timed out' : (stderr || stdout || 'exit ' + exitCode).trim()}`);
  }
  return stdout.trim();
}

function focusedWindow(dump: string, packageName: string) {
  const focus = [...dump.matchAll(/mCurrentFocus=(Window\{[^}\n]+\})/g)]
    .map(match => match[1])
    .find(name => name.includes(' ' + packageName + '/'));
  if (!focus) return null;
  const block = dump.split(/^\s*Window #\d+ /m).find(section => section.startsWith(focus + ':'));
  const match = block?.match(/\b(?:frame|mFrame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

async function waitForWindow(adb: Adb, packageName: string, state: State) {
  const expected = state === 'folded' ? /^(?:folded|closed)$/i : /^(?:unfolded|opened|open|flat)$/i;
  const deadline = Date.now() + 12_000;
  let previous = '';
  let posture = '';
  do {
    const [deviceState, dump] = await Promise.all([
      adb('shell', 'cmd', 'device_state', 'state'),
      adb('shell', 'dumpsys', 'window', '-a'),
    ]);
    posture = deviceState.match(/Committed state:[^\n]*?\bname=['"]([^'"]+)['"]/)?.[1] ?? '';
    const window = focusedWindow(dump, packageName);
    const observation = expected.test(posture) && window ? JSON.stringify([posture, window]) : '';
    if (observation && observation === previous) return { posture, window };
    previous = observation;
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error(`Could not observe a stable ${state} window for ${packageName}. Last committed posture: ${posture || 'unavailable'}.`);
}

async function readHinge(adb: Adb, state: State) {
  // Framework display features describe a fold in the natural orientation of the inner display.
  if (state === 'unfolded') {
    const probes = [
      ['settings', 'get', 'global', 'display_features'],
      ['cmd', 'overlay', 'lookup', 'android', 'android:string/config_display_features'],
    ];
    for (const probe of probes) {
      const value = await adb('shell', ...probe).catch(() => '');
      const match = value.match(/\b(hinge|fold)-\[(\d+),(\d+),(\d+),(\d+)\]/);
      if (match) {
        const [left, top, right, bottom] = match.slice(2).map(Number);
        return { hinge: { type: match[1], left, top, right, bottom, source: probe.join(' '), coordinateSpace: 'natural display pixels' } };
      }
    }
  }
  return { hinge: null, hingeReason: state === 'folded' ? 'Inner display geometry does not describe the cover window.' : 'Android exposed no configured display fold or hinge rectangle.' };
}

async function deviceTime(adb: Adb) {
  const timestamp = await adb('shell', 'date', '+%s.%N');
  if (!/^\d{9,}\.\d+$/.test(timestamp)) throw new Error('Device did not provide a logcat timestamp.');
  return timestamp;
}

async function runSequence(apk: string, serial: string, states: State[]): Promise<CallToolResult> {
  const steps: Record<string, unknown>[] = [];
  const images: ImageContent[] = [];
  let packageName: string | undefined;
  try {
    const adbPath = await sdkExecutable('adb');
    const adb: Adb = (...args) => checked(adbPath, ['-s', serial, ...args]);
    const badging = await checked(await sdkExecutable('aapt'), ['dump', 'badging', apk]);
    packageName = badging.match(/^package: name='([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)'/m)?.[1];
    if (!packageName) throw new Error('aapt could not identify the APK package.');
    if (await adb('get-state') !== 'device') throw new Error('Emulator is not online: ' + serial);
    await adb('install', '-r', apk);
    const resolved = await adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName);
    const component = resolved.split(/\r?\n/).at(-1) ?? '';
    if (!component.startsWith(packageName + '/') || !/^[\w.]+\/[\w.$]+$/.test(component)) throw new Error('No launcher Activity found for ' + packageName);
    const packages = await adb('shell', 'pm', 'list', 'packages', '-U', packageName);
    const uid = packages.split(/\r?\n/).find(line => line.startsWith('package:' + packageName + ' '))?.match(/\buid:(\d+)/)?.[1];
    if (!uid) throw new Error('Could not resolve logcat UID for ' + packageName);
    let since = await deviceTime(adb);
    // adb shell concatenates its arguments on-device. Quote inner-class names containing $.
    await adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-n', "'" + component + "'");
    for (const [index, requestedState] of states.entries()) {
      if (index > 0) since = await deviceTime(adb);
      await adb('emu', requestedState === 'folded' ? 'fold' : 'unfold');
      const observation = await waitForWindow(adb, packageName, requestedState);
      const [geometry, { stdout: png }, appLog, eventLog, appEvents] = await Promise.all([
        readHinge(adb, requestedState),
        execFileAsync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
          encoding: 'buffer', timeout: 15_000, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL',
        }),
        adb('logcat', '-d', '-b', 'main', '-v', 'epoch', '-T', since, '--uid=' + uid),
        adb('logcat', '-d', '-b', 'events', '-v', 'epoch', '-T', since),
        adb('logcat', '-d', '-b', 'events', '-v', 'epoch', '-T', since, '--uid=' + uid),
      ]);
      if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Emulator returned an invalid PNG screenshot.');
      const packageEvents = eventLog.split(/\r?\n/).filter(line =>
        line.split(/[\s,\[\]]+/).some(field => field.startsWith(packageName + '/'))
      );
      const lifecycleEvents = [...new Set([...packageEvents, ...appEvents.split(/\r?\n/)])]
        .filter(line => /\b(?:wm|am)_(?:on_|create_|restart_|resume_|relaunch_|pause_|stop_|destroy_|finish_|set_resumed_)/.test(line))
        .sort();
      images.push({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
      steps.push({ index, requestedState, ...observation, ...geometry, screenshotContentIndex: images.length,
        lifecycleEvents, appLogs: appLog.split(/\r?\n/).filter(line => line && !line.startsWith('---------')) });
    }
    const result = jsonResult({ packageName, emulatorSerial: serial, steps });
    result.content.push(...images);
    return result;
  } catch (error) {
    const result = jsonResult({ packageName, emulatorSerial: serial, steps, error: error instanceof Error ? error.message : String(error) }, true);
    result.content.push(...images);
    return result;
  }
}

export async function handle(this: GodotServer, input: unknown): Promise<CallToolResult> {
  const { apkPath, emulatorSerial, states } = this.normalizeParameters(input ?? {});
  if (typeof apkPath !== 'string' || extname(apkPath).toLowerCase() !== '.apk'
    || !(await stat(apkPath).catch(() => null))?.isFile()) {
    return jsonResult({ error: 'apkPath must point to an existing APK file.' }, true);
  }
  if (typeof emulatorSerial !== 'string' || !/^emulator-\d+$/.test(emulatorSerial)
    || !Array.isArray(states) || !states.length || !states.every(state => state === 'folded' || state === 'unfolded')) {
    return jsonResult({ error: 'Provide emulatorSerial and a nonempty array of folded or unfolded states.' }, true);
  }
  if (busy.has(emulatorSerial)) return jsonResult({ error: 'A foldable test is already running on ' + emulatorSerial }, true);
  busy.add(emulatorSerial);
  try {
    return await runSequence(resolve(apkPath), emulatorSerial, states);
  } finally {
    busy.delete(emulatorSerial);
  }
}

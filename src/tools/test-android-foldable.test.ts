import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './test-android-foldable.ts';

const server = { normalizeParameters: (value: unknown) => value } as GodotServer;

test('foldable APK is launched once, and each committed state has its own window, logs and PNG', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'foldable-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const originalSDK = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = dir;
  t.after(() => {
    if (originalSDK === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = originalSDK;
  });
  const buildTools = join(dir, 'build-tools', '36.0.0');
  await mkdir(buildTools, { recursive: true });
  await mkdir(join(dir, 'platform-tools'));
  const apk = join(dir, 'game debug.apk');
  const adb = join(dir, 'platform-tools', 'adb');
  const aapt = join(buildTools, 'aapt');
  await writeFile(apk, 'fake');
  await writeFile(aapt, "#!/usr/bin/env node\nconsole.log(\"package: name='com.example.game'\");\n");
  await writeFile(adb, `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.ANDROID_HOME;
const [target, serial, ...argv] = process.argv.slice(2);
if (target !== '-s' || serial !== 'emulator-5554') process.exit(2);
fs.appendFileSync(dir + '/calls', JSON.stringify(argv) + '\\n');
const stateFile = dir + '/state';
const command = argv.join(' ');
if (command === 'get-state') console.log('device');
else if (argv[0] === 'install') console.log('Success');
else if (command.startsWith('shell cmd package resolve-activity ')) console.log('com.example.game/.Main');
else if (command.startsWith('shell pm list packages -U')) console.log('package:com.example.game uid:10042');
else if (command === 'shell date +%s.%N') console.log('1724000000.123456789');
else if (command.startsWith('shell am start -W ')) console.log('Status: ok');
else if (argv[0] === 'emu') {
  if (argv[1] === 'unfold' && fs.existsSync(dir + '/fail')) console.log('KO: cannot unfold');
  else fs.writeFileSync(stateFile, argv[1] === 'fold' ? 'CLOSED' : 'OPENED');
} else if (command === 'shell cmd device_state state') console.log("Committed state: DeviceState{identifier=3, name='" + fs.readFileSync(stateFile, 'utf8') + "'}");
else if (command === 'shell dumpsys window -a') {
  const width = fs.readFileSync(stateFile, 'utf8') === 'CLOSED' ? 900 : 1800;
  console.log('mCurrentFocus=Window{123 u0 com.example.game/.Main}\\n  Window #0 Window{456 u0 system/dialog}:\\n    frame=[0,0][1,1]\\n  Window #1 Window{123 u0 com.example.game/.Main}:\\n    Frames: parent=[0,0][400,500]\\n    frame=[0,20][' + width + ',920]');
} else if (command === 'shell settings get global display_features') console.log('hinge-[888,0,912,900]');
else if (command === 'exec-out screencap -p') process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2+aiAAAAAASUVORK5CYII=', 'base64'));
else if (argv[0] === 'logcat') {
  if (!argv.includes('1724000000.123456789')) process.exit(1);
  if (argv.includes('main') && argv.includes('--uid=10042')) console.log('session=3 score=8');
  else if (argv.includes('--uid=10042')) console.log('wm_on_resume_called: [0,org.godotengine.Game,RESUME_ACTIVITY]');
  else console.log('wm_resume_activity: [0,com.example.game/.Main]\\nwm_resume_activity: [0,com.example.game.other/.Main]');
} else { console.error('Unexpected command: ' + command); process.exit(3); }
`);
  await chmod(adb, 0o755);
  await chmod(aapt, 0o755);
  const args = { apkPath: apk, emulatorSerial: 'emulator-5554', states: ['folded', 'unfolded'] };
  const result = await handle.call(server, args);
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  const { steps } = result.structuredContent as { steps: any[] };
  assert.deepEqual(steps.map(s => s.posture), ['CLOSED', 'OPENED']);
  assert.deepEqual(steps.map(s => s.window.width), [900, 1800]);
  assert.equal(steps[0].window.height, 900);
  assert.equal(steps[0].hinge, null);
  assert.ok(steps[0].hingeReason);
  assert.equal(steps[1].hinge.right, 912);
  assert.equal(steps[1].hinge.coordinateSpace, 'natural display pixels');
  for (const step of steps) {
    assert.equal(result.content[step.screenshotContentIndex].type, 'image');
    assert.deepEqual(step.appLogs, ['session=3 score=8']);
    assert.equal(step.lifecycleEvents.length, 2);
    assert.ok(step.lifecycleEvents.every((line: string) => !line.includes('game.other')));
  }
  const calls = (await readFile(join(dir, 'calls'), 'utf8')).split('\n');
  assert.equal(calls.filter(call => call.includes('"am","start"')).length, 1);
  assert.equal(calls.filter(call => call.includes('"install"')).length, 1);

  await writeFile(join(dir, 'fail'), '');
  const partial = await handle.call(server, args);
  assert.equal(partial.isError, true);
  assert.match(String(partial.structuredContent?.error), /cannot unfold/);
  assert.equal(partial.content.length, 2);
});

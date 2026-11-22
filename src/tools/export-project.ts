import { stripVTControlCharacters } from 'node:util';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { jsonResult, requireGodot, requireProject, runCommand } from '../tool-runtime.ts';

export const definition: Tool = {
  name: 'export_project',
  description: 'Build a Godot export preset and verify the produced artifact, including APK signing.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      preset: { type: 'string', description: 'Exact name from export_presets.cfg.' },
      mode: { type: 'string', enum: ['debug', 'release'] },
      outputPath: { type: 'string', description: 'Absolute or project-relative artifact path, including its filename.' },
    },
    required: ['projectPath', 'preset', 'mode', 'outputPath'],
  },
};

type Check = { name: string; passed: boolean; detail: string };
const busyDirectories = new Set<string>();

async function apkSigner() {
  const windows = process.platform === 'win32';
  const candidates: string[] = [];
  for (const sdk of new Set([process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT])) {
    if (!sdk) continue;
    const buildTools = join(sdk, 'build-tools');
    const versions = await readdir(buildTools).catch((): string[] => []);
    versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    candidates.push(...versions.map(v => join(buildTools, v)));
  }
  candidates.push(...(process.env.PATH || '').split(delimiter).filter(Boolean));
  for (const dir of candidates) {
    // Use the SDK jar on Windows so caller-provided paths never pass through cmd.exe.
    if (windows) {
      const jar = join(dir, 'lib', 'apksigner.jar');
      if (existsSync(jar)) {
        const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java.exe';
        return { executable: java, args: ['-jar', jar] };
      }
    }
    const executable = join(dir, windows ? 'apksigner.exe' : 'apksigner');
    if (existsSync(executable)) return { executable, args: [] };
  }
  throw new Error('apksigner is missing. Install Android SDK Build Tools and set ANDROID_HOME or add its build-tools version directory to PATH.');
}

// A web/desktop export can have sidecars and shared directories. Merge generated files,
// preserving unrelated files and restoring prior versions if publication fails.
async function publish(staging: string, destination: string, backupDir: string) {
  const changes: { source: string; target: string; backup?: string; installed?: boolean }[] = [];
  async function install(source: string, target: string) {
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const sourceIsDirectory = (await lstat(source)).isDirectory();
    if (existing?.isDirectory() && sourceIsDirectory) {
      for (const name of await readdir(source)) await install(join(source, name), join(target, name));
      return;
    }
    if (existing && existing.isDirectory() !== sourceIsDirectory) {
      throw new Error(`Cannot replace a different type of entry at ${target}`);
    }
    const change: typeof changes[number] = { source, target };
    if (existing) {
      change.backup = join(backupDir, String(changes.length));
      await rename(target, change.backup);
    }
    changes.push(change);
    await rename(source, target);
    change.installed = true;
  }
  try {
    for (const name of await readdir(staging)) await install(join(staging, name), join(destination, name));
  } catch (error) {
    try {
      for (const { source, target, backup, installed } of changes.reverse()) {
        if (installed) await rename(target, source);
        if (backup) await rename(backup, target);
      }
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Export rollback failed. Previous artifacts remain in ${backupDir}: ${restoreError}`);
    }
    throw error;
  }
}

function diagnoseExport(output: string, checks: Check[]) {
  const prerequisites: [string, RegExp][] = [
    ['templates', /export template|template file|android_(debug|release)\.apk|gradle built template/i],
    ['jdk', /java sdk|\bjdk\b|java_home/i],
    ['androidSdk', /android sdk|platform-tools|build-tools/i],
    ['apksigner', /apksigner/i],
    ['preset', /export preset|export_presets\.cfg/i],
  ];
  for (const [name, pattern] of prerequisites) {
    const detail = output.split(/\r?\n/).filter(line => pattern.test(line)).join('\n');
    if (detail) checks.push({ name, passed: false, detail });
  }
}

export async function handle(this: GodotServer, input: any) {
  const checks: Check[] = [];
  let work: string | undefined;
  let locked: string | undefined;
  try {
    const args = this.normalizeParameters(input ?? {});
    const project = await requireProject(args.projectPath);
    if (typeof args.preset !== 'string' || !args.preset.trim() || !['debug', 'release'].includes(args.mode)) {
      throw new Error('Provide a preset name and mode debug or release.');
    }
    if (typeof args.outputPath !== 'string' || !args.outputPath.trim() || !this.validatePath(args.outputPath)) {
      throw new Error('Provide a valid outputPath including the artifact filename.');
    }
    const outputPath = resolve(project, args.outputPath);
    const destination = dirname(outputPath);
    if (busyDirectories.has(destination)) throw new Error(`An export is active in ${destination}.`);
    busyDirectories.add(destination);
    locked = destination;

    const engine = await requireGodot(this);
    const version = await runCommand(engine, ['--version']);
    if (version.exitCode !== 0 || !version.stdout.trim()) {
      throw new Error('Could not determine the Godot engine version. ' + version.stderr.trim());
    }
    checks.push({ name: 'engine', passed: true, detail: version.stdout.trim() });
    if (!existsSync(join(project, 'export_presets.cfg'))) {
      throw new Error('Missing export_presets.cfg. Configure an export preset in the Godot editor.');
    }
    await mkdir(destination, { recursive: true });
    work = await mkdtemp(join(destination, '.godot-mcp-export-'));
    const staging = join(work, 'artifacts');
    const backupDir = join(work, 'previous');
    await mkdir(staging);
    await mkdir(backupDir);
    const artifact = join(staging, basename(outputPath));
    // Godot validates the selected preset, custom templates and platform SDKs with
    // the same editor settings it uses for the actual export.
    const build = await runCommand(engine, ['--headless', '--path', project, '--export-' + args.mode, args.preset, artifact], {
      cwd: project, timeoutMs: 900_000,
    });
    const output = stripVTControlCharacters([build.stdout, build.stderr].join('\n'));
    const diagnosticLines = output.split(/\r?\n/).filter(line => /^\s*(?:SCRIPT ERROR|ERROR|WARNING):/.test(line));
    // Godot may emit a nonfatal ERROR (e.g. a missing project icon) and successfully sign the APK.
    // Verify the fresh artifact below and retain engine diagnostics in the success report.
    const exportFailed = diagnosticLines.some(line => /SCRIPT ERROR:|project export .*failed|cannot export project/i.test(line));
    if (build.timedOut || build.exitCode !== 0 || exportFailed) {
      const detail = stripVTControlCharacters(build.stderr.trim() || build.stdout.trim()).slice(-16000);
      diagnoseExport(detail, checks);
      throw new Error(build.timedOut ? 'Godot export timed out.\n' + detail : detail || `Godot exited with code ${build.exitCode}`);
    }
    const entry = await lstat(artifact).catch(() => null);
    const hasFile = entry?.isFile() && entry.size > 0;
    const hasBundle = entry?.isDirectory() && (await readdir(artifact)).length > 0;
    if (!hasFile && !hasBundle) {
      throw new Error(`Godot did not create a new, nonempty ${basename(outputPath)}.\n${diagnosticLines.join('\n')}`);
    }
    checks.push({ name: 'export', passed: true, detail: `Godot exported preset "${args.preset}" in ${args.mode} mode.` });
    if (extname(artifact).toLowerCase() === '.apk') {
      const signer = await apkSigner();
      const signature = await runCommand(signer.executable, [...signer.args, 'verify', '--verbose', '--print-certs', artifact]);
      const detail = [signature.stdout, signature.stderr].filter(Boolean).join('\n').trim();
      const passed = signature.exitCode === 0 && !signature.timedOut;
      checks.push({ name: 'signature', passed, detail });
      if (!passed) throw new Error('APK signature verification failed. ' + detail);
    }
    await publish(staging, destination, backupDir);
    return jsonResult({ status: 'succeeded', artifactPath: outputPath, checks, diagnostics: diagnosticLines });
  } catch (error) {
    if (error instanceof AggregateError) work = undefined;
    return jsonResult({ status: 'failed', artifactPath: null, checks, message: String(error) }, true);
  } finally {
    if (locked) busyDirectories.delete(locked);
    if (work) await rm(work, { recursive: true, force: true });
  }
}

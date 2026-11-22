import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './export-project.ts';

test('export_project verifies a fresh signed APK, diagnoses prerequisites and preserves existing artifacts on failure', {
  skip: process.platform === 'win32',
}, async () => {
  const project = await mkdtemp(join(tmpdir(), 'godot-export-test-'));
  const env = { PATH: process.env.PATH, ANDROID_HOME: process.env.ANDROID_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT };
  const engine = join(project, 'godot');
  const signer = join(project, 'apksigner');
  const target = join(project, 'out', 'build with spaces.apk');
  const server = { godotPath: engine, normalizeParameters: (args: unknown) => args, validatePath: () => true } as unknown as GodotServer;
  async function exportPreset(preset: string) {
    return handle.call(server, { projectPath: project, preset, mode: 'debug', outputPath: target });
  }
  try {
    process.env.PATH = project;
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    await writeFile(join(project, 'project.godot'), 'config_version=5\n');
    await writeFile(join(project, 'export_presets.cfg'), '[preset.0]\nname="Android"\nplatform="Android"\n');
    await writeFile(engine, `#!${process.execPath}
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('4.4.1.stable');
else {
  assert.ok(args.includes('--headless') && args.includes('--export-debug'));
  assert.equal(args[args.indexOf('--path') + 1], process.cwd());
  const [preset, artifact] = args.slice(-2);
  if (preset === 'Missing tools') {
    console.error("ERROR: Missing export template\\nA valid Java SDK path is required in Editor Settings.\\nInvalid Android SDK path.");
    process.exit(1);
  }
  if (preset === 'Android') console.error('ERROR: No project icon specified.');
  if (preset !== 'No output') writeFileSync(artifact, preset);
}`, { mode: 0o755 });
    await writeFile(signer, `#!${process.execPath}
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.argv[2], 'verify');
if (readFileSync(process.argv.at(-1), 'utf8') !== 'Android') process.exit(1);
console.log('Verified using v2 scheme');`, { mode: 0o755 });
    const ok = await exportPreset('Android');
    assert.equal(ok.structuredContent?.artifactPath, target, String(ok.structuredContent?.message));
    assert.equal(ok.structuredContent?.status, 'succeeded');
    assert.deepEqual(ok.structuredContent?.diagnostics, ['ERROR: No project icon specified.']);
    assert.deepEqual((ok.structuredContent?.checks as { name: string }[]).map(c => c.name), ['engine', 'export', 'signature']);
    const missing = await exportPreset('Missing tools');
    assert.ok(missing.isError);
    assert.match(String(missing.structuredContent?.message), /Java SDK/);
    const checkNames = (missing.structuredContent?.checks as { name: string }[]).map(c => c.name);
    for (const name of ['templates', 'jdk', 'androidSdk']) assert.ok(checkNames.includes(name));
    const stale = await exportPreset('No output');
    assert.ok(stale.isError);
    assert.equal(stale.structuredContent?.artifactPath, null);
    const unsigned = await exportPreset('Unsigned');
    assert.ok(unsigned.isError);
    assert.match(String(unsigned.structuredContent?.message), /signature verification failed/);
    await rm(signer);
    const noSigner = await exportPreset('Android');
    assert.ok(noSigner.isError);
    assert.match(String(noSigner.structuredContent?.message), /apksigner is missing/);
    assert.equal(await readFile(target, 'utf8'), 'Android');
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(project, { recursive: true, force: true });
  }
});

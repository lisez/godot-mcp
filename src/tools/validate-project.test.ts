import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './validate-project.ts';

test('validation discovers standalone test entries and reports skipped candidates', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'godot-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'project.godot'), 'config_version=5\n');
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'entry.test.gd'), 'extends SceneTree\n');
  await writeFile(join(root, 'tests', 'other.gd'), 'extends MainLoop\n');
  await writeFile(join(root, 'tests', 'helper.gd'), 'extends Node\n');
  const godotPath = join(root, 'fake-engine');
  await writeFile(godotPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (!args.includes('--import') && !args.includes('--check-only') && !args.includes('--script')) process.exit(1);
`, { mode: 0o755 });
  const server = {
    godotPath, normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await handle.call(server, { projectPath: root });
  assert.equal(result.structuredContent?.status, 'inconclusive');
  const stages = result.structuredContent?.stages as Array<Record<string, unknown>>;
  const testStage = stages.find(stage => stage.name === 'tests')!;
  assert.deepEqual((testStage.results as Array<{ path: string }>).map(test => test.path), ['entry.test.gd', 'tests/other.gd']);
  assert.deepEqual((testStage.skipped as Array<{ path: string }>).map(test => test.path), ['tests/helper.gd']);
});

test('validation stops after import diagnostics even with a zero exit code', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'godot-validation-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'project.godot'), 'config_version=5\n');
  await writeFile(join(root, 'failure.test.gd'), 'extends SceneTree\n');
  const godotPath = join(root, 'fake-engine');
  await writeFile(godotPath, `#!${process.execPath}
console.error('SCRIPT ERROR: Parse Error: bad syntax');
console.error('          at: GDScript::reload (res://failure.test.gd:2)');
`, { mode: 0o755 });
  const server = {
    godotPath, normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await handle.call(server, { projectPath: root });
  assert.equal(result.structuredContent?.status, 'failed');
  assert.equal(result.structuredContent?.firstFailureStage, 'import');
  const stages = result.structuredContent?.stages as Array<Record<string, unknown>>;
  const importStage = stages.find(stage => stage.name === 'import')!;
  assert.deepEqual((importStage.diagnostics as Array<{ file: string; line: number }>).map(({ file, line }) => [file, line]), [['res://failure.test.gd', 2]]);
  assert.equal(stages.find(stage => stage.name === 'tests')!.status, 'skipped');
});

test('validation does not pass when it finds no runnable tests', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'godot-validation-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'project.godot'), 'config_version=5\n');
  const godotPath = join(root, 'fake-engine');
  await writeFile(godotPath, `#!${process.execPath}\n`, { mode: 0o755 });
  const server = {
    godotPath, normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await handle.call(server, { projectPath: root });
  assert.equal(result.structuredContent?.status, 'inconclusive');
  const stages = result.structuredContent?.stages as Array<Record<string, unknown>>;
  assert.equal(stages.find(stage => stage.name === 'tests')!.status, 'inconclusive');
});

test('validation discovers and runs a real Godot test after parsing project scripts', {
  skip: !process.env.GODOT_TEST_BIN && 'Set GODOT_TEST_BIN to run Godot integration tests.',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'godot-validation-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'project.godot'), 'config_version=5\n');
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'test', 'entry.gd'), 'extends SceneTree\nfunc _initialize():\n\tquit()\n');
  await writeFile(join(root, 'other.gd'), 'extends Node\n');
  const server = {
    godotPath: process.env.GODOT_TEST_BIN, normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await handle.call(server, { projectPath: root });
  assert.equal(result.structuredContent?.status, 'passed', JSON.stringify(result));
  const repeat = await handle.call(server, { projectPath: root });
  assert.equal(repeat.structuredContent?.status, 'passed', JSON.stringify(repeat));
  await writeFile(join(root, 'other.gd'), 'extends Node\nfunc broken(:\n');
  const failure = await handle.call(server, { projectPath: root });
  assert.equal(failure.structuredContent?.status, 'failed');
  const stages = failure.structuredContent?.stages as Array<Record<string, unknown>>;
  const output = JSON.stringify(stages);
  assert.match(output, /other\.gd/);
});

test('validation identifies a missing native extension', {
  skip: !process.env.GODOT_TEST_BIN && 'Set GODOT_TEST_BIN to run Godot integration tests.',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'godot-validation-extension-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'project.godot'), 'config_version=5\n');
  await writeFile(join(root, 'missing.gdextension'), '[configuration]\nentry_symbol="missing_init"\ncompatibility_minimum="4.1"\n[libraries]\nwindows.debug.x86_64="res://missing.dll"\nlinux.debug.x86_64="res://missing.so"\n');
  const server = {
    godotPath: process.env.GODOT_TEST_BIN, normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await handle.call(server, { projectPath: root });
  assert.equal(result.structuredContent?.status, 'failed', JSON.stringify(result));
  assert.equal(result.structuredContent?.firstFailureStage, 'extensions', JSON.stringify(result));
});

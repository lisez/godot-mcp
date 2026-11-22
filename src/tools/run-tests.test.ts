import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './run-tests.ts';

test('run_tests classifies headless output, exit codes, and deadlines', { skip: process.platform === 'win32' }, async t => {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-test-runner-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await writeFile(join(projectPath, 'project.godot'), '');
  const godotPath = join(projectPath, 'fake-godot.mjs');
  await writeFile(godotPath, `#!${process.execPath}
import { readFileSync } from 'node:fs';
const [headless, path, project, script, file] = process.argv.slice(2);
if (headless !== '--headless' || path !== '--path' || script !== '--script') process.exit(99);
switch (readFileSync(file, 'utf8')) {
  case 'assertion':
    console.error('SCRIPT ERROR: Assertion failed: movement');
    console.error('          at: _run (res://regression.gd:8)');
    break;
  case 'parse':
    console.log('SCRIPT ERROR: Parse Error: Expected identifier');
    console.log('          at: GDScript::reload (res://regression.gd:5)');
    break;
  case 'code': process.exit(7);
  case 'sleep': setTimeout(() => {}, 5000); break;
  default: console.log('PASS');
}
`, { mode: 0o755 });
  const server = { godotPath, normalizeParameters: (args: unknown) => args } as GodotServer;
  const scriptPath = 'regression.gd';
  for (const [fixture, status] of Object.entries({
    passing: 'passed', assertion: 'failed', parse: 'failed', code: 'failed', sleep: 'timed_out',
  })) {
    await writeFile(join(projectPath, scriptPath), fixture);
    const result = await handle.call(server, { projectPath, scriptPath, timeoutMs: fixture === 'sleep' ? 150 : 5000 });
    const data = result.structuredContent;
    assert.equal(data.status, status, JSON.stringify({fixture, data}));
    assert.equal(!!result.isError, status !== 'passed');
    if (fixture === 'assertion' || fixture === 'parse') {
      assert.equal(data.exitCode, 0);
      assert.equal(data.diagnostics[0].file, 'res://regression.gd');
      assert.equal(data.diagnostics[0].line, fixture === 'assertion' ? 8 : 5);
      assert.match(data.diagnostics[0].message, /movement|Expected identifier/);
    }
    if (fixture === 'code') assert.equal(data.exitCode, 7);
  }
});

test('run_tests retains the failing GDScript location after Godot exits zero', {
  skip: process.env.GODOT_TEST_BIN ? false : 'Set GODOT_TEST_BIN to a Godot 4 editor executable.',
}, async t => {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-assertion-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n');
  const scriptPath = 'assertion.gd';
  await writeFile(join(projectPath, scriptPath), [
    'extends SceneTree',
    'func _initialize():',
    '\tcheck_direction()',
    '\tquit(0)',
    'func check_direction():',
    '\tassert(false, "direction mismatch")',
  ].join('\n'));
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
  } as GodotServer;
  const result = await handle.call(server, { projectPath, scriptPath });
  const { exitCode, status, diagnostics } = result.structuredContent;
  assert.equal(exitCode, 0);
  assert.equal(status, 'failed');
  assert.equal(diagnostics[0].file, 'res://assertion.gd');
  assert.equal(diagnostics[0].line, 6);
  assert.match(diagnostics[0].message, /direction mismatch/);
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectFile, requireProject, runCommand } from './tool-runtime.ts';

test('project files resolve inside the project, including through symlinks', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'godot-mcp-paths-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project');
  await mkdir(root);
  await writeFile(join(root, 'project.godot'), '');
  await writeFile(join(temp, 'outside.gd'), '');
  const canonicalRoot = await requireProject(root);
  assert.equal(await projectFile(canonicalRoot, 'res://project.godot'), join(canonicalRoot, 'project.godot'));
  await assert.rejects(projectFile(canonicalRoot, '../outside.gd'), /inside the project/);
  if (process.platform !== 'win32') {
    await symlink(join(temp, 'outside.gd'), join(root, 'linked.gd'));
    await assert.rejects(projectFile(canonicalRoot, 'linked.gd'), /inside the project/);
  }
});

test('process results preserve diagnostics and distinguish failure, timeout and launch errors', async () => {
  const failed = await runCommand(process.execPath, ['-e', 'console.error("failed"); process.exitCode = 3']);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.timedOut, false);
  assert.equal(failed.stderr.trim(), 'failed');

  const stopped = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 120 });
  assert.equal(stopped.timedOut, true);
  await assert.rejects(runCommand('godot-mcp-nonexistent-command', []), { code: 'ENOENT' });
});

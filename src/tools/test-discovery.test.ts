import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverTests } from './test-discovery.ts';

test('discovers and deduplicates standalone Godot tests, reporting other candidates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'godot-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test', 'nested'), { recursive: true });
  await mkdir(join(root, 'tests', 'ignored'), { recursive: true });
  await writeFile(join(root, 'root.test.gd'), 'extends SceneTree\n');
  await writeFile(join(root, 'test', 'nested', 'a.test.gd'), '# test\n@tool\nclass_name Example\nextends MainLoop # entry\n');
  await writeFile(join(root, 'tests', 'helper.gd'), 'extends Node\n');
  await writeFile(join(root, 'tests', 'literal.gd'), 'extends Node\nconst SAMPLE = """\nextends SceneTree\n"""\n');
  await writeFile(join(root, 'tests', 'data.txt'), 'fixture');
  await writeFile(join(root, 'tests', 'helper.gd.uid'), 'uid://example');
  await writeFile(join(root, 'tests', 'image.png.import'), 'generated import metadata');
  await writeFile(join(root, 'tests', 'ignored', '.gdignore'), '');
  await writeFile(join(root, 'tests', 'ignored', 'ignored.test.gd'), 'extends SceneTree\n');
  const entries = await discoverTests(root);
  assert.deepEqual(entries.map(entry => [entry.path, entry.runnable]), [
    ['root.test.gd', true],
    ['test/nested/a.test.gd', true],
    ['tests/data.txt', false],
    ['tests/helper.gd', false],
    ['tests/literal.gd', false],
  ]);
});

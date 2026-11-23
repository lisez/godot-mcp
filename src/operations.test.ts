import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from './tool-runtime.ts';

const godot = process.env.GODOT_TEST_BIN;

test('dedicated packaged operations preserve Godot behavior and shared invocation', {
  skip: godot ? false : 'Set GODOT_TEST_BIN to run the Godot integration test.',
  timeout: 120_000,
}, async t => {
  assert.ok(godot);
  const project = await mkdtemp(join(process.cwd(), '.operation-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(join(project, 'project.godot'), 'config_version=5\n');
  await writeFile(join(project, 'custom-node.gd'), 'class_name SplitOperationFixtureNode\nextends Node2D\n');
  await writeFile(join(project, 'texture.tres'), '[gd_resource type="GradientTexture2D" format=3]\n\n[resource]\n');
  await writeFile(join(project, 'mesh-scene.tscn'), `[gd_scene load_steps=2 format=3]

[sub_resource type="BoxMesh" id="BoxMesh_1"]

[node name="Root" type="Node3D"]

[node name="Box" type="MeshInstance3D" parent="."]
mesh = SubResource("BoxMesh_1")
`);

  const imported = await runCommand(godot, ['--headless', '--path', project, '--import'], { timeoutMs: 60_000 });
  assert.equal(imported.exitCode, 0, imported.stderr);

  async function operation(script: string, params: object, debug = false) {
    const args = ['--headless', '--path', project, '--script', join(process.cwd(), 'dist', 'scripts', script), JSON.stringify(params)];
    if (debug) args.push('--debug-godot');
    const result = await runCommand(godot!, args, { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0, `${script}: ${result.stdout}\n${result.stderr}`);
    return result;
  }

  const created = await operation('create-scene.gd', { scene_path: 'main.tscn', root_node_type: 'Node2D' }, true);
  assert.match(created.stdout, /\[DEBUG\] Params JSON:/);
  assert.match(created.stdout, /Scene created successfully/);
  await operation('add-node.gd', { scene_path: 'main.tscn', node_type: 'Sprite2D', node_name: 'Sprite' });
  await operation('add-node.gd', { scene_path: 'main.tscn', node_type: 'SplitOperationFixtureNode', node_name: 'Custom' });
  await operation('load-sprite.gd', { scene_path: 'main.tscn', node_path: 'root/Sprite', texture_path: 'texture.tres' });
  const scene = await readFile(join(project, 'main.tscn'), 'utf8');
  assert.match(scene, /name="Sprite" type="Sprite2D"/);
  assert.match(scene, /custom-node\.gd/);
  assert.match(scene, /texture\.tres/);

  const exported = await operation('export-mesh-library.gd', { scene_path: 'mesh-scene.tscn', output_path: 'meshes.tres' });
  assert.match(exported.stdout, /MeshLibrary exported successfully/);
  assert.match(await readFile(join(project, 'meshes.tres'), 'utf8'), /item\/0\/name = "Box"/);
  await operation('save-scene.gd', { scene_path: 'main.tscn', new_path: 'copies/main.tscn' });
  assert.match(await readFile(join(project, 'copies', 'main.tscn'), 'utf8'), /name="Sprite"/);

  await writeFile(join(project, 'custom-node.gd.uid'), 'uid://bfixtureuid\n');
  const uid = await operation('get-uid.gd', { file_path: 'custom-node.gd' });
  assert.match(uid.stdout, /uid:\/\/bfixtureuid/);
  const resaved = await operation('resave-resources.gd', { project_path: 'res://' });
  assert.match(resaved.stdout, /Resave operation complete/);

  const script = join(process.cwd(), 'dist', 'scripts', 'get-uid.gd');
  const malformed = await runCommand(godot, ['--headless', '--path', project, '--script', script, '{'], { timeoutMs: 30_000 });
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /Failed to parse JSON parameters/);
  const missing = await runCommand(godot, ['--headless', '--path', project, '--script', script], { timeoutMs: 30_000 });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Not enough command-line arguments/);
  const invalidClass = await operation('create-scene.gd', { scene_path: 'bad.tscn', root_node_type: 'NoSuchNodeClass' });
  assert.match(invalidClass.stderr, /Failed to instantiate node/);
  assert.ok(!(await readdir(project)).includes('operation-common.gd'));
});

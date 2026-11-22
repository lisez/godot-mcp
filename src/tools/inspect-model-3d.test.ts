import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './inspect-model-3d.ts';

const godotPath = process.env.GODOT_TEST_BIN;

test('inspect_model_3d measures a transformed scene and an imported GLB using Godot', {
  skip: godotPath ? false : 'Set GODOT_TEST_BIN to a Godot 4 editor executable.',
}, async t => {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-model-'));
  t.after(() => rm(projectPath, { recursive: true, force: true }));
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n');
  await writeFile(join(projectPath, 'nested.tscn'), `[gd_scene format=3]

[node name="Root" type="Node3D"]
position = Vector3(2, 3, 4)

[node name="Pivot" type="Node3D" parent="."]
transform = Transform3D(0, 0, 1, 0, 1, 0, -2, 0, 0, 0, 3, 0)

[node name="Tip" type="Node3D" parent="Pivot"]
position = Vector3(2, 0, 0)
`);
  const server = {
    godotPath, normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as GodotServer;
  async function inspect(modelPath: string, fromNode: string, toNode: string) {
    const result = await handle.call(server, { projectPath, modelPath, fromNode, toNode });
    assert.ok(!result.isError, JSON.stringify(result.content));
    return result.structuredContent;
  }
  const scene = await inspect('nested.tscn', 'Pivot', 'Pivot/Tip');
  assert.deepEqual(scene.nodes[0].localTransform.origin, [2, 3, 4]);
  assert.deepEqual(scene.nodes[0].modelTransform.origin, [0, 0, 0]);
  assert.deepEqual(scene.nodes[2].localTransform.origin, [2, 0, 0]);
  assert.deepEqual(scene.nodes[2].modelTransform.origin, [0, 3, -4]);
  assert.equal(scene.nodes[2].parent, 'Pivot');
  assert.deepEqual(scene.measurement.direction, [0, 0, -1]);
  assert.equal(scene.measurement.distance, 4);
  assert.equal((await inspect('nested.tscn', '.', '.')).measurement.direction, null);

  // A JSON-only GLB containing a model and a child node one unit along +Z.
  const gltf = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Model', children: [1] }, { name: 'Marker', translation: [0, 0, 1] }],
  });
  const jsonLength = Math.ceil(gltf.length / 4) * 4;
  const glb = Buffer.alloc(20 + jsonLength, 0x20);
  glb.write('glTF');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.write('JSON', 16);
  glb.write(gltf, 20);
  await writeFile(join(projectPath, 'model.glb'), glb);
  const imported = await handle.call(server, { projectPath, modelPath: 'model.glb' });
  assert.ok(!imported.isError, JSON.stringify(imported.content));
  const marker = imported.structuredContent.nodes.find((node: { name: string }) => node.name === 'Marker');
  assert.ok(marker);
  const model = await inspect('model.glb', '.', marker.path);
  assert.deepEqual(model.measurement.direction, [0, 0, 1]);
});

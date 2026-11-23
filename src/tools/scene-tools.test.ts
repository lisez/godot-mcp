import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle as inspectScene } from './inspect-scene.ts';
import { definition as editSceneDefinition, handle as editScene } from './edit-scene.ts';
import { handle as previewScene } from './preview-scene.ts';

const fakeGodot = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--import')) process.exit(0);
const root = args[args.indexOf('--path') + 1];
const script = args[args.indexOf('--script') + 1];
const requestIndex = args.indexOf('--') + 1;
const request = JSON.parse(Buffer.from(args[requestIndex], 'base64').toString('utf8'));
if (script.endsWith('inspect-scene.gd')) {
  console.log('GODOT_MCP_INSPECT_SCENE=' + JSON.stringify({
    scenePath: request.scenePath, inspection: 'file_local_serialized_state', runtimeSnapshot: false,
    nodes: [{ path: '.', name: 'Root', type: 'Node2D', groups: ['fixture'], properties: [] }],
    connections: [], externalResources: [],
  }));
} else if (script.endsWith('edit-scene.gd')) {
  const stage = path.join(root, request.stagePath.slice('res://'.length));
  fs.writeFileSync(stage, '[gd_scene format=3]\\\\n# staged fixture\\\\n');
  if (process.env.FAKE_STAGE_CLEANUP_FAIL === '1') {
    fs.rmSync(stage, { force: true });
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'leftover'), 'fixture');
  }
  if (process.env.FAKE_EDIT_CONFLICT === '1') fs.writeFileSync(path.join(root, 'main.tscn'), 'concurrent edit');
  console.log('GODOT_MCP_EDIT_SCENE=' + JSON.stringify({
    changes: request.operations.map((operation, index) => ({ index, operation: operation.type })),
    sharedExternalResources: [], stagedSceneReloaded: true,
  }));
} else if (script.endsWith('preview-scene.gd')) {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(request.width, 16);
  png.writeUInt32BE(request.height, 20);
  console.log('GODOT_MCP_PREVIEW_SCENE=' + JSON.stringify({
    png: png.toString('base64'), captureFrame: request.captureFrame, pixelHash: '0'.repeat(64),
  }));
} else {
  console.error('Unexpected helper: ' + script);
  process.exitCode = 2;
}
`;

async function fixture(t: { after(callback: () => void): void }) {
  const root = await mkdtemp(join(process.cwd(), '.scene-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scenes'));
  await writeFile(join(root, 'project.godot'), 'config_version=5\n');
  await writeFile(join(root, 'main.tscn'), '[gd_scene format=3]\n');
  await writeFile(join(root, 'scenes', 'child.tscn'), `[gd_scene load_steps=2 format=3]

[sub_resource type="CanvasItemMaterial" id="CanvasItemMaterial_child"]

[node name="Child" type="Node2D"]
material = SubResource("CanvasItemMaterial_child")
`);
  const binary = join(root, 'fake-godot');
  await writeFile(binary, fakeGodot);
  await chmod(binary, 0o755);
  const server = {
    godotPath: binary,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  return { root, server };
}

test('inspect_scene returns serialized file-local data with both parameter naming styles', async t => {
  const { root, server } = await fixture(t);
  const result = await inspectScene.call(server, { project_path: root, scene_path: 'main.tscn' });
  const data = result.structuredContent as any;
  assert.equal(data.runtimeSnapshot, false);
  assert.deepEqual(data.nodes[0].groups, ['fixture']);
});

test('edit_scene previews by default, stages and applies only after verification', async t => {
  const { root, server } = await fixture(t);
  const before = await readFile(join(root, 'main.tscn'), 'utf8');
  const operations = [
    { type: 'create_node', parentPath: '.', name: 'Child', nodeType: 'Node2D' },
    { type: 'set_property', nodePath: 'Child', property: 'position', value: { type: 'Vector2', value: [10, 20] } },
  ];
  const preview = await editScene.call(server, { projectPath: root, scenePath: 'main.tscn', operations });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent?.applied, false);
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), before);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.godot-mcp-scene-')), []);

  const applied = await editScene.call(server, { projectPath: root, scenePath: 'main.tscn', operations, mode: 'apply' });
  assert.equal(applied.isError, undefined, JSON.stringify(applied.structuredContent));
  assert.equal(applied.structuredContent?.applied, true);
  assert.match(await readFile(join(root, 'main.tscn'), 'utf8'), /staged fixture/);
  assert.deepEqual((applied.structuredContent as any).changes.map((change: any) => change.index), [0, 1]);
});

test('edit_scene rejects fingerprint conflicts without replacing the concurrently changed target', async t => {
  const { root, server } = await fixture(t);
  const original = process.env.FAKE_EDIT_CONFLICT;
  process.env.FAKE_EDIT_CONFLICT = '1';
  t.after(() => {
    if (original === undefined) delete process.env.FAKE_EDIT_CONFLICT;
    else process.env.FAKE_EDIT_CONFLICT = original;
  });
  const result = await editScene.call(server, {
    projectPath: root, scenePath: 'main.tscn',
    operations: [{ type: 'create_node', parentPath: '.', name: 'Added', nodeType: 'Node2D' }],
    mode: 'apply',
  });
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /changed after preview/);
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), 'concurrent edit');
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.godot-mcp-scene-')), []);
});

test('edit_scene rejects a stale preview fingerprint before staging apply', async t => {
  const { root, server } = await fixture(t);
  const operations = [{ type: 'create_node', parentPath: '.', name: 'Added', nodeType: 'Node2D' }];
  const preview = await editScene.call(server, { projectPath: root, scenePath: 'main.tscn', operations });
  const expectedOriginalFingerprint = (preview.structuredContent as any).expectedOriginalFingerprint;
  assert.match(expectedOriginalFingerprint, /^[a-f0-9]{64}$/);
  await writeFile(join(root, 'main.tscn'), 'changed after preview');
  const result = await editScene.call(server, {
    projectPath: root, scenePath: 'main.tscn', operations, mode: 'apply', expectedOriginalFingerprint,
  });
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /changed since the supplied preview fingerprint/);
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), 'changed after preview');
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.godot-mcp-scene-')), []);
});

test('edit_scene exposes concrete operation and typed-value schemas', () => {
  const schema = editSceneDefinition.inputSchema.properties as any;
  const operations = schema.operations.items.oneOf as any[];
  assert.deepEqual(operations.map(operation => operation.properties.type.const), [
    'create_node', 'instantiate_scene', 'set_property', 'connect_signal',
  ]);
  const value = operations[2].properties.value;
  assert.ok(value.oneOf.some((variant: any) => variant.properties?.type?.const === 'Vector2'));
  assert.ok(value.oneOf.some((variant: any) => variant.properties?.type?.const === 'Transform3D'));
  assert.ok(value.oneOf.some((variant: any) => variant.properties?.path?.pattern === '^res://'));
  assert.match(schema.expectedOriginalFingerprint.description, /preview/);
});

test('edit_scene reports cleanup failure while preserving the preview outcome', async t => {
  const { root, server } = await fixture(t);
  const original = process.env.FAKE_STAGE_CLEANUP_FAIL;
  process.env.FAKE_STAGE_CLEANUP_FAIL = '1';
  t.after(() => {
    if (original === undefined) delete process.env.FAKE_STAGE_CLEANUP_FAIL;
    else process.env.FAKE_STAGE_CLEANUP_FAIL = original;
  });
  const before = await readFile(join(root, 'main.tscn'), 'utf8');
  const result = await editScene.call(server, {
    projectPath: root, scenePath: 'main.tscn',
    operations: [{ type: 'create_node', parentPath: '.', name: 'Added', nodeType: 'Node2D' }],
  });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as any).operationSucceeded, true);
  assert.equal((result.structuredContent as any).applied, false);
  assert.match((result.structuredContent as any).cleanupError, /Could not remove temporary staged scene/);
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), before);
});

test('edit_scene validates project-contained scene references before launching Godot', async t => {
  const { root, server } = await fixture(t);
  const result = await editScene.call(server, {
    projectPath: root, scenePath: 'main.tscn',
    operations: [{ type: 'instantiate_scene', parentPath: '.', name: 'Child', scenePath: '../package.json' }],
  });
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /inside the project/);
});

test('preview_scene returns a dimension-checked PNG and does not alter active project process', async t => {
  const { root, server } = await fixture(t);
  const activeProcess = { process: { marker: 'active' }, output: [], errors: [] };
  (server as any).activeProcess = activeProcess;
  const result = await previewScene.call(server, {
    projectPath: root, scenePath: 'main.tscn', width: 640, height: 360, captureFrame: 0,
  });
  assert.equal('isError' in result ? result.isError : undefined, undefined);
  assert.equal((result.content[1] as any).type, 'image');
  assert.equal((result.content[1] as any).mimeType, 'image/png');
  assert.equal((result.structuredContent as any).width, 640);
  assert.equal((server as any).activeProcess, activeProcess);
  assert.equal((result.structuredContent as any).captureFrame, 0);
});

test('real Godot inspects, previews and applies a typed scene edit', {
  skip: process.env.GODOT_TEST_BIN ? false : 'Set GODOT_TEST_BIN to a Godot 4 executable or path bridge.',
}, async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'root.gd'), `extends Node2D

func _on_pressed() -> void:
	pass
`);
  await writeFile(join(root, 'animated.gd'), `extends Node2D

var ticks := 0

func _process(_delta: float) -> void:
	ticks += 1
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(Vector2(ticks * 10, 10), Vector2(20, 20)), Color.RED)
`);
  await writeFile(join(root, 'shared-style.tres'), `[gd_resource type="StyleBoxFlat" format=3]

[resource]
bg_color = Color(0.5, 0.25, 0.75, 1)
`);
  await writeFile(join(root, 'main.tscn'), `[gd_scene load_steps=5 format=3]

[ext_resource type="Script" path="res://root.gd" id="1"]
[ext_resource type="StyleBoxFlat" path="res://shared-style.tres" id="2"]
[ext_resource type="Script" path="res://animated.gd" id="3"]

[sub_resource type="CanvasItemMaterial" id="CanvasItemMaterial_embedded"]

[node name="Root" type="Node2D" groups=["fixture"]]
position = Vector2(4, 8)
script = ExtResource("1")
material = SubResource("CanvasItemMaterial_embedded")

[node name="Panel" type="Panel" parent="."]
theme_override_styles/panel = ExtResource("2")

[node name="Animated" type="Node2D" parent="."]
script = ExtResource("3")
`);
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const inspected = await inspectScene.call(server, { projectPath: root, scenePath: 'main.tscn' });
  assert.ok(!inspected.isError, JSON.stringify(inspected.structuredContent));
  const inspectedData = inspected.structuredContent as any;
  assert.equal(inspectedData.runtimeSnapshot, false);
  assert.deepEqual(inspectedData.nodes[0].groups, ['fixture']);
  assert.ok(inspectedData.nodes[0].properties.some((property: any) => property.name === 'position'));
  assert.ok(inspectedData.externalResources.some((resource: any) => resource.path === 'res://shared-style.tres'));
  assert.ok(inspectedData.embeddedResources.some((resource: any) => resource.path.includes('res://main.tscn::')));
  const embeddedProperty = inspectedData.nodes[0].properties.find((property: any) => property.name === 'material');
  assert.equal(embeddedProperty.value.embedded, true);
  assert.equal(embeddedProperty.value.external, false);
  const externalProperty = inspectedData.nodes.find((node: any) => node.name === 'Panel')
    .properties.find((property: any) => property.name === 'theme_override_styles/panel');
  assert.equal(externalProperty.value.external, true);

  const operations = [
    { type: 'create_node', parentPath: '.', name: 'Marker', nodeType: 'Node2D' },
    { type: 'set_property', nodePath: 'Marker', property: 'position', value: { type: 'Vector2', value: [10, 20] } },
    { type: 'instantiate_scene', parentPath: '.', name: 'Sub', scenePath: 'scenes/child.tscn' },
    { type: 'create_node', parentPath: '.', name: 'Action', nodeType: 'Button' },
    { type: 'connect_signal', sourcePath: 'Action', signal: 'pressed', targetPath: '.', method: '_on_pressed' },
  ];
  const original = await readFile(join(root, 'main.tscn'), 'utf8');
  const preview = await editScene.call(server, { projectPath: root, scenePath: 'main.tscn', operations });
  assert.ok(!preview.isError, JSON.stringify(preview.structuredContent));
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), original);
  const applied = await editScene.call(server, { projectPath: root, scenePath: 'main.tscn', operations, mode: 'apply' });
  assert.ok(!applied.isError, JSON.stringify(applied.structuredContent));
  assert.equal((applied.structuredContent as any).applied, true);
  const sharedResources = (applied.structuredContent as any).sharedExternalResources;
  assert.ok(sharedResources.some((resource: any) => resource.path === 'res://shared-style.tres'));
  assert.ok(sharedResources.some((resource: any) => resource.path === 'res://scenes/child.tscn::CanvasItemMaterial_child'));
  assert.ok(!sharedResources.some((resource: any) => resource.path.startsWith('res://main.tscn::')));
  assert.ok((applied.structuredContent as any).embeddedResources.some((resource: any) => resource.path.includes('res://main.tscn::')));
  const after = await inspectScene.call(server, { projectPath: root, scenePath: 'main.tscn' });
  assert.ok(!after.isError, JSON.stringify(after.structuredContent));
  assert.ok((after.structuredContent as any).nodes.some((node: any) => node.path.endsWith('Marker')), JSON.stringify(after.structuredContent));
  assert.ok((after.structuredContent as any).nodes.some((node: any) => node.path.endsWith('Sub')), JSON.stringify(after.structuredContent));
  assert.ok((after.structuredContent as any).connections.some((connection: any) =>
    connection.source === 'Action' && connection.signal === 'pressed' && connection.target === '.'), JSON.stringify(after.structuredContent));
  const subsceneEdit = await editScene.call(server, {
    projectPath: root,
    scenePath: 'main.tscn',
    operations: [{ type: 'set_property', nodePath: 'Sub', property: 'position', value: { type: 'Vector2', value: [1, 2] } }],
  });
  assert.equal(subsceneEdit.isError, true);
  assert.match((subsceneEdit.content[0] as { text: string }).text, /instanced subscene/);

  if (!process.env.DISPLAY && process.platform !== 'win32') {
    t.diagnostic('preview skipped: DISPLAY is not configured.');
    return;
  }
  const renderedPreview = await previewScene.call(server, {
    projectPath: root, scenePath: 'main.tscn', width: 320, height: 180, captureFrame: 0,
  });
  if ('isError' in renderedPreview && renderedPreview.isError) {
    const report = renderedPreview.structuredContent as any;
    if (report?.error === 'A graphical display and rendering backend are required; this host is headless.') {
      t.diagnostic(`preview renderer unavailable: ${report.error}`);
      return;
    }
    assert.fail(JSON.stringify(report));
  }
  assert.equal((renderedPreview.structuredContent as any).width, 320);
  assert.equal((renderedPreview.structuredContent as any).height, 180);
  assert.equal((renderedPreview.structuredContent as any).captureFrame, 0);
  assert.match((renderedPreview.structuredContent as any).pixelHash, /^[a-f0-9]{64}$/);
  assert.equal((renderedPreview.content[1] as any).mimeType, 'image/png');
  const widePng = Buffer.from((renderedPreview.content[1] as any).data, 'base64');
  assert.equal(widePng.readUInt32BE(16), 320);
  assert.equal(widePng.readUInt32BE(20), 180);
  const laterPreview = await previewScene.call(server, {
    projectPath: root, scenePath: 'main.tscn', width: 320, height: 180, captureFrame: 3,
  });
  assert.ok(!('isError' in laterPreview && laterPreview.isError), JSON.stringify(laterPreview.structuredContent));
  assert.equal((laterPreview.structuredContent as any).captureFrame, 3);
  assert.notEqual((laterPreview.structuredContent as any).pixelHash, (renderedPreview.structuredContent as any).pixelHash,
    'later physics-frame pixels should differ for the animated fixture');
  const laterPng = Buffer.from((laterPreview.content[1] as any).data, 'base64');
  assert.notDeepEqual(laterPng, widePng, 'later zero-based frame should reflect the animated scene');
  const narrowPreview = await previewScene.call(server, { projectPath: root, scenePath: 'main.tscn', width: 320, height: 640, captureFrame: 0 });
  assert.ok(!('isError' in narrowPreview && narrowPreview.isError), JSON.stringify(narrowPreview.structuredContent));
  assert.equal((narrowPreview.structuredContent as any).width, 320);
  assert.equal((narrowPreview.structuredContent as any).height, 640);
  assert.equal((narrowPreview.content[1] as any).mimeType, 'image/png');
  const narrowPng = Buffer.from((narrowPreview.content[1] as any).data, 'base64');
  assert.equal(narrowPng.readUInt32BE(16), 320);
  assert.equal(narrowPng.readUInt32BE(20), 640);
});

test('real Godot rejects an inherited scene before writing a staged edit', {
  skip: process.env.GODOT_TEST_BIN ? false : 'Set GODOT_TEST_BIN to a Godot 4 executable or path bridge.',
}, async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'main.tscn'), `[gd_scene format=3]

[node name="Root" type="Node2D"]
`);
  const inherited = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://main.tscn" id="1"]

[node name="Root" instance=ExtResource("1")]
`;
  await writeFile(join(root, 'inherited.tscn'), inherited);
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await editScene.call(server, {
    projectPath: root,
    scenePath: 'inherited.tscn',
    operations: [{ type: 'create_node', parentPath: '.', name: 'Added', nodeType: 'Node2D' }],
  });
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /Editing inherited scenes is unsupported/);
  assert.equal(await readFile(join(root, 'inherited.tscn'), 'utf8'), inherited);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.godot-mcp-scene-')), []);
});

test('real Godot preserves existing subscene instances and overrides after an unrelated edit', {
  skip: process.env.GODOT_TEST_BIN ? false : 'Set GODOT_TEST_BIN to a Godot 4 executable or path bridge.',
}, async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'scenes', 'child.tscn'), `[gd_scene format=3]

[node name="Child" type="Node2D"]

[node name="Inner" type="Node2D" parent="."]
position = Vector2(1, 2)
`);
  const original = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://scenes/child.tscn" id="1"]

[node name="Root" type="Node2D"]

[node name="Existing" parent="." instance=ExtResource("1")]
position = Vector2(30, 40)

[node name="Inner" parent="Existing" index="0"]
position = Vector2(9, 10)

[editable path="Existing"]
`;
  await writeFile(join(root, 'main.tscn'), original);
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const request = { projectPath: root, scenePath: 'main.tscn' };
  const before = await inspectScene.call(server, request);
  assert.ok(!before.isError, JSON.stringify(before.structuredContent));
  const beforeData = before.structuredContent as any;
  const instanceBefore = beforeData.nodes.find((node: any) => node.name === 'Existing');
  const innerBefore = beforeData.nodes.find((node: any) => node.name === 'Inner');
  assert.equal(instanceBefore.source, 'instanced');
  assert.equal(instanceBefore.sourceScene, 'res://scenes/child.tscn');
  assert.ok(instanceBefore.properties.some((property: any) => property.name === 'position'));
  assert.ok(innerBefore.properties.some((property: any) => property.name === 'position'));

  const result = await editScene.call(server, {
    ...request, mode: 'apply',
    operations: [{ type: 'create_node', parentPath: '.', name: 'Unrelated', nodeType: 'Node2D' }],
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const after = await inspectScene.call(server, request);
  assert.ok(!after.isError, JSON.stringify(after.structuredContent));
  const afterData = after.structuredContent as any;
  const instanceAfter = afterData.nodes.find((node: any) => node.name === 'Existing');
  const innerAfter = afterData.nodes.find((node: any) => node.name === 'Inner');
  assert.deepEqual(instanceAfter, instanceBefore);
  assert.deepEqual(innerAfter, innerBefore);
  assert.match(await readFile(join(root, 'main.tscn'), 'utf8'), /\[editable path="Existing"\]/);
});

test('real Godot rejects unsupported instance override values without modifying the scene', {
  skip: process.env.GODOT_TEST_BIN ? false : 'Set GODOT_TEST_BIN to a Godot 4 executable or path bridge.',
}, async t => {
  const { root } = await fixture(t);
  const original = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://scenes/child.tscn" id="1"]

[node name="Root" type="Node2D"]

[node name="Existing" parent="." instance=ExtResource("1")]
metadata/custom = PackedStringArray("one", "two")
`;
  await writeFile(join(root, 'main.tscn'), original);
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const result = await editScene.call(server, {
    projectPath: root, scenePath: 'main.tscn', mode: 'apply',
    operations: [{ type: 'create_node', parentPath: '.', name: 'Unrelated', nodeType: 'Node2D' }],
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Cannot safely preserve an unsupported property value/);
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), original);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.godot-mcp-scene-')), []);
});

test('real Godot rejects malformed typed values nested in properties and signal binds', {
  skip: process.env.GODOT_TEST_BIN ? false : 'Set GODOT_TEST_BIN to a Godot 4 executable or path bridge.',
}, async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'receiver.gd'), `extends Node2D

func receive(_argument: Variant) -> void:
	pass
`);
  const original = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://receiver.gd" id="1"]

[node name="Root" type="Node2D"]
script = ExtResource("1")
metadata/array = []
metadata/dictionary = {}

[node name="Button" type="Button" parent="."]
`;
  await writeFile(join(root, 'main.tscn'), original);
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  const malformed = { type: 'Vector2', value: [1] };
  const operations = [
    { type: 'set_property', nodePath: '.', property: 'metadata/array', value: [{ nested: [malformed] }] },
    { type: 'set_property', nodePath: '.', property: 'metadata/dictionary', value: { inner: { type: 'Array', value: [{ type: 'NotAType', value: 1 }] } } },
    { type: 'set_property', nodePath: '.', property: 'metadata/dictionary', value: { type: 'Dictionary', value: [{ key: 'bad', value: malformed }] } },
    { type: 'connect_signal', sourcePath: 'Button', signal: 'pressed', targetPath: '.', method: 'receive', binds: [[malformed]] },
  ];
  const valid = await editScene.call(server, {
    projectPath: root, scenePath: 'main.tscn',
    operations: [{
      type: 'set_property', nodePath: '.', property: 'metadata/array',
      value: [{ nested: [{ type: 'Vector2', value: [1, 2] }] }],
    }],
  });
  assert.ok(!valid.isError, JSON.stringify(valid));
  assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), original);
  for (const operation of operations) {
    const result = await editScene.call(server, {
      projectPath: root, scenePath: 'main.tscn', mode: 'apply', operations: [operation],
    });
    assert.equal(result.isError, true, JSON.stringify(operation));
    assert.match(JSON.stringify(result), /unsupported or malformed typed value/i);
    assert.equal(await readFile(join(root, 'main.tscn'), 'utf8'), original);
  }
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.godot-mcp-scene-')), []);
});

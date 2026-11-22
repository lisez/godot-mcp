import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './replay-input.ts';

const server = {
  godotPath: process.env.GODOT_TEST_BIN,
  normalizeParameters: (p: unknown) => p,
  createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
} as unknown as GodotServer;

test('replay rejects a drag for a finger that was never pressed', async () => {
  const result = await handle.call(server, {
    seed: 3, events: [{ frame: 0, fingerId: 2, type: 'drag', x: 4, y: 5 }], captures: [],
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Invalid drag for finger 2/);
});

test('replay injects ordered touch input before physics and captures the seeded scene', {
  skip: !process.env.GODOT_TEST_BIN && 'Set GODOT_TEST_BIN to run the engine integration test.',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-test-'));
  try {
    await writeFile(join(root, 'project.godot'), `config_version=5

[application]
config/name="Replay fixture"

[display]
window/size/viewport_width=320
window/size/viewport_height=180
window/size/window_width_override=640
window/size/window_height_override=360
window/stretch/mode="canvas_items"

[rendering]
renderer/rendering_method="gl_compatibility"
`);
    await writeFile(join(root, 'scene.tscn'), `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://scene.gd" id="1"]
[node name="Actor" type="Node2D"]
script = ExtResource("1")
[node name="Noise" type="Node3D" parent="."]
`);
    await writeFile(join(root, 'scene.gd'), `extends Node2D

var held := {}
var event_order := 0

func _ready():
	$Noise.position.x = randf()

func _input(event):
	if event is InputEventScreenTouch or event is InputEventScreenDrag:
		event_order = event_order * 10 + event.index
		if event is InputEventScreenTouch and not event.pressed:
			held.erase(event.index)
		else:
			held[event.index] = event.position

func _physics_process(_delta):
	position.x = event_order
	position.y = 0
	for pos in held.values():
		position.y += pos.x
`);
    const screenshot = process.env.GODOT_REPLAY_SCREENSHOT_TEST === '1';
    const args = {
      projectPath: root, scenePath: 'scene.tscn', seed: 123,
      events: [
        { frame: 0, fingerId: 2, type: 'press', x: 8, y: 9 },
        { frame: 0, fingerId: 1, type: 'press', x: 10, y: 1 },
        { frame: 1, fingerId: 1, type: 'drag', x: 20, y: 3 },
        { frame: 1, fingerId: 2, type: 'release', x: 8, y: 9 },
        { frame: 2, fingerId: 1, type: 'release', x: 20, y: 3 },
      ],
      captures: [0, 1, 2].map(frame => ({ frame, nodePaths: ['.', 'Noise'], screenshot: screenshot && frame === 0 })),
    };
    const first = await handle.call(server, args);
    assert.ok(!first.isError, JSON.stringify(first.content));
    const captures = first.structuredContent!.captures as { positions: Record<string, number[]>; imageContentIndex?: number }[];
    assert.deepEqual(captures.map(c => c.positions['.'][0]), [21, 2112, 21121]);
    const heldPositions = [18, 20, 0];
    captures.forEach((capture, i) => assert.ok(Math.abs(capture.positions['.'][1] - heldPositions[i]) < 0.0001));
    if (screenshot) {
      const image = first.content[captures[0].imageContentIndex!];
      assert.equal(image.type, 'image');
      assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
    }
    const again = await handle.call(server, { ...args, captures: [{ frame: 0, nodePaths: ['Noise'] }] });
    assert.ok(!again.isError, JSON.stringify(again.content));
    const repeat = again.structuredContent!.captures as typeof captures;
    assert.deepEqual(repeat[0].positions.Noise, captures[0].positions.Noise);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

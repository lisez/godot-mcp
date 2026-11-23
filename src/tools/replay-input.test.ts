import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
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

test('replay validates keyboard, mouse, joypad, and assertion schedules', async () => {
  const invalidCases = [
    {
      events: [{ frame: 0, type: 'key', keycode: 65, pressed: false }],
      captures: [], assertions: [],
      message: /Invalid release state for key:0:65/,
    },
    {
      events: [{ frame: 0, type: 'joypad_axis', axis: 10, value: 0 }],
      captures: [], assertions: [],
      message: /axis 0-9/,
    },
    {
      events: [],
      captures: [],
      assertions: [{ frame: 0, nodePath: '../Outside', property: 'position', operator: 'equals', expected: [0, 0] }],
      message: /relative to the scene root/,
    },
    {
      events: [],
      captures: [],
      assertions: [{ frame: 0, nodePath: '.', property: 'position', operator: 'approximately', expected: [0, 0] }],
      message: /requires a numeric or vector expected value and a finite nonnegative tolerance/,
    },
  ];
  for (const invalid of invalidCases) {
    const result = await handle.call(server, { projectPath: '.', scenePath: 'scene.tscn', seed: 1, ...invalid });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), invalid.message);
  }
});

test('replay reports structured assertion failures while retaining legacy results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-fake-'));
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    await writeFile(join(root, 'scene.tscn'), '[gd_scene format=3]\n');
    const fakeEngine = join(root, 'fake-godot.mjs');
    await writeFile(fakeEngine, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
if (process.argv.includes('--import')) process.exit(0);
const requestPath = process.argv.at(-1);
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const captures = request.captures.map(({ frame }) => ({ frame, positions: {} }));
const assertions = request.assertions.map((item, index) => ({
  ...item, actual: index === 0 ? item.expected : null, passed: index === 0,
  ...(index === 0 ? {} : { error: 'Node path was not found.' }),
}));
writeFileSync(join(dirname(requestPath), 'result.json'), JSON.stringify({ captures, assertions }));
`);
    await chmod(fakeEngine, 0o755);
    const fakeServer = { ...server, godotPath: fakeEngine } as GodotServer;
    const failed = await handle.call(fakeServer, {
      projectPath: root, scenePath: 'scene.tscn', seed: 8,
      events: [
        { frame: 0, type: 'key', keycode: 65, pressed: true },
        { frame: 0, type: 'mouse_button', buttonIndex: 4, pressed: true, x: 10, y: 10 },
        { frame: 0, type: 'mouse_button', buttonIndex: 4, pressed: true, x: 10, y: 10 },
        { frame: 1, type: 'key', keycode: 65, pressed: false },
      ],
      captures: [{ frame: 0 }],
      assertions: [
        { frame: 0, nodePath: '.', property: 'visible', operator: 'equals', expected: true },
        { frame: 1, nodePath: 'Missing', property: 'position', operator: 'equals', expected: [0, 0] },
      ],
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent?.status, 'failed');
    assert.deepEqual(failed.structuredContent?.failures, [{
      frame: 1, nodePath: 'Missing', property: 'position', operator: 'equals',
      expected: [0, 0], actual: null, passed: false, error: 'Node path was not found.',
    }]);

    const legacy = await handle.call(fakeServer, {
      projectPath: root, scenePath: 'scene.tscn', seed: 8, events: [], captures: [{ frame: 0 }],
    });
    assert.equal(legacy.isError, undefined);
    assert.deepEqual(Object.keys(legacy.structuredContent!).sort(), ['captures', 'seed']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
var key_state := false
var mouse_position := Vector2.ZERO
var joypad_button_state := false
var joypad_axis_value := 0.0
var device_sequence := ""
var physics_updated := false

func _ready():
	$Noise.position.x = randf()

func _input(event):
	if event is InputEventScreenTouch or event is InputEventScreenDrag:
		event_order = event_order * 10 + event.index
		if event is InputEventScreenTouch and not event.pressed:
			held.erase(event.index)
		else:
			held[event.index] = event.position
	elif event is InputEventKey:
		key_state = event.pressed
		device_sequence += "K"
	elif event is InputEventMouseButton or event is InputEventMouseMotion:
		mouse_position = event.position
		device_sequence += "B" if event is InputEventMouseButton else "M"
	elif event is InputEventJoypadButton:
		joypad_button_state = event.pressed
		device_sequence += "J"
	elif event is InputEventJoypadMotion:
		joypad_axis_value = event.axis_value
		device_sequence += "A"

func _physics_process(_delta):
	physics_updated = true
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

    const devices = await handle.call(server, {
      projectPath: root, scenePath: 'scene.tscn', seed: 123,
      events: [
        { frame: 0, type: 'key', keycode: 65, pressed: true },
        { frame: 0, type: 'mouse_button', buttonIndex: 4, pressed: true, x: 10, y: 10 },
        { frame: 0, type: 'mouse_button', buttonIndex: 4, pressed: true, x: 10, y: 10 },
        { frame: 0, type: 'mouse_button', buttonIndex: 1, pressed: true, x: 30, y: 40 },
        { frame: 0, type: 'mouse_motion', x: 34, y: 45 },
        { frame: 0, type: 'joypad_button', buttonIndex: 0, pressed: true },
        { frame: 0, type: 'joypad_axis', axis: 0, value: 0.75 },
        { frame: 1, type: 'key', keycode: 65, pressed: false },
        { frame: 1, type: 'mouse_button', buttonIndex: 1, pressed: false, x: 34, y: 45 },
        { frame: 1, type: 'joypad_button', buttonIndex: 0, pressed: false },
      ],
      captures: [{ frame: 0, nodePaths: ['.'] }],
      assertions: [
        { frame: 0, nodePath: '.', property: 'key_state', operator: 'equals', expected: true },
        { frame: 0, nodePath: '.', property: 'mouse_position', operator: 'approximately', expected: [34, 45], tolerance: 0.001 },
        { frame: 0, nodePath: '.', property: 'joypad_button_state', operator: 'equals', expected: true },
        { frame: 0, nodePath: '.', property: 'joypad_axis_value', operator: 'approximately', expected: 0.75, tolerance: 0.001 },
        { frame: 0, nodePath: '.', property: 'position', operator: 'approximately', expected: [0, 0], tolerance: 0.001 },
        { frame: 0, nodePath: '.', property: 'event_order', operator: 'greater_than', expected: -1 },
        { frame: 0, nodePath: '.', property: 'event_order', operator: 'not_equals', expected: 1 },
        { frame: 0, nodePath: '.', property: 'device_sequence', operator: 'equals', expected: 'KBBBMJA' },
        { frame: 0, nodePath: '.', property: 'physics_updated', operator: 'equals', expected: true },
        { frame: 0, nodePath: '.', property: 'key_state', operator: 'equals', expected: false },
        { frame: 0, nodePath: 'Missing', property: 'position', operator: 'equals', expected: [0, 0] },
        { frame: 0, nodePath: '.', property: 'event_order', operator: 'approximately', expected: [0, 0], tolerance: 0.001 },
        { frame: 0, nodePath: '.', property: 'event_order', operator: 'not_equals', expected: '0' },
        { frame: 0, nodePath: '.', property: 'position', operator: 'equals', expected: 0 },
      ],
    });

    assert.equal(devices.isError, true, JSON.stringify(devices.content));
    const deviceResult = devices.structuredContent!;
    assert.equal(deviceResult.status, 'failed');
    assert.equal((deviceResult.assertions as { passed: boolean }[]).length, 14);
    assert.equal((deviceResult.failures as { error?: string }[]).length, 5);
    const failures = deviceResult.failures as { frame: number; nodePath: string; operator: string; expected: unknown; actual: unknown; error?: string }[];
    assert.match(failures[1].error!, /Node path was not found/);
    assert.deepEqual(
      { frame: failures[1].frame, nodePath: failures[1].nodePath, operator: failures[1].operator, expected: failures[1].expected, actual: failures[1].actual },
      { frame: 0, nodePath: 'Missing', operator: 'equals', expected: [0, 0], actual: null },
    );
    assert.match(failures[2].error!, /approximately requires matching numeric or vector values/);
    assert.match(failures[3].error!, /incompatible/);
    assert.match(failures[4].error!, /incompatible/);

    const assertionsOnly = await handle.call(server, {
      projectPath: root, scenePath: 'scene.tscn', seed: 123,
      events: [], captures: [],
      assertions: [{ frame: 2, nodePath: '.', property: 'physics_updated', operator: 'equals', expected: true }],
    });
    assert.ok(!assertionsOnly.isError, JSON.stringify(assertionsOnly.content));
    assert.equal(assertionsOnly.structuredContent?.status, 'passed');
    assert.deepEqual(assertionsOnly.structuredContent?.captures, []);
    assert.equal((assertionsOnly.structuredContent?.assertions as { passed: boolean }[])[0].passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('screenshots preserve post-physics assertions and subsequent frame order', {
  skip: (!process.env.GODOT_TEST_BIN || process.env.GODOT_REPLAY_SCREENSHOT_TEST !== '1') &&
    'Set GODOT_TEST_BIN and GODOT_REPLAY_SCREENSHOT_TEST=1 to run the renderer integration test.',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-frames-'));
  try {
    await writeFile(join(root, 'project.godot'), `config_version=5
[application]
config/name="Replay frame fixture"
[display]
window/size/viewport_width=64
window/size/viewport_height=64
[rendering]
renderer/rendering_method="gl_compatibility"
`);
    await writeFile(join(root, 'scene.tscn'), `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://scene.gd" id="1"]
[node name="Actor" type="Node2D"]
script = ExtResource("1")
`);
    await writeFile(join(root, 'scene.gd'), `extends Node2D
var ticks := 0
var presses := 0

func _ready():
	process_mode = Node.PROCESS_MODE_ALWAYS

func _input(event):
	if event is InputEventKey and event.pressed:
		presses += 1

func _physics_process(_delta):
	ticks += 1
	position.x = ticks
	queue_redraw()
	if ticks == 1:
		RenderingServer.set_render_loop_enabled(false)
		get_tree().create_timer(0.35).timeout.connect(func(): RenderingServer.set_render_loop_enabled(true))

func _draw():
	draw_rect(Rect2(-position.x, 0, 64, 64), Color.RED if ticks == 1 else Color.GREEN)
`);
    const result = await handle.call(server, {
      projectPath: root, scenePath: 'scene.tscn', seed: 1,
      events: [
        { frame: 0, type: 'key', keycode: 65, pressed: true },
        { frame: 1, type: 'key', keycode: 65, pressed: false },
        { frame: 1, type: 'key', keycode: 66, pressed: true },
      ],
      captures: [
        { frame: 0, nodePaths: ['.'], screenshot: true },
        { frame: 1, nodePaths: ['.'], screenshot: true },
        { frame: 2, nodePaths: ['.'] },
      ],
      assertions: [
        { frame: 0, nodePath: '.', property: 'ticks', operator: 'equals', expected: 1 },
        { frame: 0, nodePath: '.', property: 'presses', operator: 'equals', expected: 1 },
        { frame: 1, nodePath: '.', property: 'ticks', operator: 'equals', expected: 2 },
        { frame: 1, nodePath: '.', property: 'presses', operator: 'equals', expected: 2 },
        { frame: 2, nodePath: '.', property: 'ticks', operator: 'equals', expected: 3 },
      ],
    });
    assert.ok(!result.isError, JSON.stringify(result.content));
    const captures = result.structuredContent!.captures as { frame: number; positions: Record<string, number[]>; imageContentIndex?: number }[];
    assert.deepEqual(captures.map(c => [c.frame, c.positions['.'][0]]), [[0, 1], [1, 2], [2, 3]]);
    assert.deepEqual(captures.map(c => c.imageContentIndex), [1, 2, undefined]);
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[2].type, 'image');
    const firstPixel = (data: string) => {
      const png = Buffer.from(data, 'base64');
      const chunks: Buffer[] = [];
      for (let offset = 8; offset < png.length;) {
        const size = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + size));
        offset += size + 12;
      }
      assert.equal(png[24], 8);
      assert.ok(png[25] === 2 || png[25] === 6);
      return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
    };
    assert.deepEqual(firstPixel(result.content[1].data as string), [255, 0, 0]);
    assert.deepEqual(firstPixel(result.content[2].data as string), [0, 255, 0]);
    assert.deepEqual((result.structuredContent!.assertions as { frame: number; actual: number }[]).map(a => [a.frame, a.actual]),
      [[0, 1], [0, 1], [1, 2], [1, 2], [2, 3]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

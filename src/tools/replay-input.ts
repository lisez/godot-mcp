import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { importProject, jsonResult, projectFile, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';

const frameProperty = { type: 'integer', minimum: 0, description: 'Zero-based physics frame.' };

export const definition: Tool = {
  name: 'replay_input',
  description: 'Replay touch, keyboard, mouse, and joypad input in physics frames; optionally capture nodes, PNGs, and frame assertions.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      scenePath: { type: 'string', description: 'Project-relative path of the starting scene.' },
      seed: { type: 'integer', description: 'Seed for Godot global random calls; project and engine behavior may still be nondeterministic.' },
      events: {
        type: 'array', description: 'Chronologically ordered synthetic events. Touch and mouse coordinates use root viewport pixels. Events do not emulate OS devices, hardware hot-plug, or platform-only input paths.',
        items: { oneOf: [
          {
            type: 'object', required: ['frame', 'fingerId', 'type', 'x', 'y'],
            properties: {
              frame: frameProperty, fingerId: { type: 'integer', minimum: 0 },
              type: { enum: ['press', 'drag', 'release'] }, x: { type: 'number' }, y: { type: 'number' },
            },
          },
          {
            type: 'object', required: ['frame', 'type', 'keycode', 'pressed'],
            properties: { frame: frameProperty, type: { const: 'key' }, keycode: { type: 'integer', minimum: 1, maximum: 2147483647 }, pressed: { type: 'boolean' }, device: { type: 'integer', minimum: 0, maximum: 2147483647 } },
          },
          {
            type: 'object', required: ['frame', 'type', 'buttonIndex', 'pressed', 'x', 'y'],
            properties: { frame: frameProperty, type: { const: 'mouse_button' }, buttonIndex: { type: 'integer', minimum: 1, maximum: 9, description: 'Godot mouse button; wheel buttons 4-7 are one-shot events.' }, pressed: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' }, device: { type: 'integer', minimum: 0, maximum: 2147483647 } },
          },
          {
            type: 'object', required: ['frame', 'type', 'x', 'y'],
            properties: { frame: frameProperty, type: { const: 'mouse_motion' }, x: { type: 'number' }, y: { type: 'number' }, device: { type: 'integer', minimum: 0, maximum: 2147483647 } },
          },
          {
            type: 'object', required: ['frame', 'type', 'buttonIndex', 'pressed'],
            properties: { frame: frameProperty, type: { const: 'joypad_button' }, buttonIndex: { type: 'integer', minimum: 0, maximum: 21 }, pressed: { type: 'boolean' }, device: { type: 'integer', minimum: 0, maximum: 2147483647 } },
          },
          {
            type: 'object', required: ['frame', 'type', 'axis', 'value'],
            properties: { frame: frameProperty, type: { const: 'joypad_axis' }, axis: { type: 'integer', minimum: 0, maximum: 9 }, value: { type: 'number', minimum: -1, maximum: 1 }, device: { type: 'integer', minimum: 0, maximum: 2147483647 } },
          },
        ] },
      },
      captures: {
        type: 'array', description: 'One capture per frame in chronological order.',
        items: {
          type: 'object', required: ['frame'],
          properties: {
            frame: frameProperty, nodePaths: { type: 'array', items: { type: 'string' } },
            screenshot: { type: 'boolean', default: false },
          },
        },
      },
      assertions: {
        type: 'array',
        description: 'Assertions are evaluated after physics at each frame. Paths are relative to the starting scene root.',
        items: {
          type: 'object', required: ['frame', 'nodePath', 'property', 'operator', 'expected'],
          properties: {
            frame: frameProperty, nodePath: { type: 'string' }, property: { type: 'string', minLength: 1 },
            operator: { enum: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'approximately'] },
            expected: { type: ['number', 'string', 'boolean', 'array', 'null'] },
            tolerance: { type: 'number', minimum: 0, description: 'Required for approximately; absolute component-wise tolerance for numbers and vectors.' },
          },
        },
      },
    },
    required: ['projectPath', 'scenePath', 'seed', 'events', 'captures'],
  },
};

interface ReplayEvent {
  frame: number;
  type: string;
  [key: string]: unknown;
}

interface Capture {
  frame: number;
  nodePaths?: string[];
  screenshot?: boolean;
}

interface Assertion {
  frame: number;
  nodePath: string;
  property: string;
  operator: string;
  expected: unknown;
  tolerance?: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePath(path: unknown, label: string): asserts path is string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..'))
    throw new Error(`${label} must be a nonempty path relative to the scene root.`);
}

function validateSchedule(events: unknown, captures: unknown, assertions: unknown): void {
  if (!Array.isArray(events) || !Array.isArray(captures) || !Array.isArray(assertions) ||
      !events.length && !captures.length && !assertions.length)
    throw new Error('Provide events, captures, or assertions with at least one scheduled item.');
  const fingers = new Set<number>();
  const pressed = new Set<string>();
  let lastFrame = -1;
  for (const event of events) {
    if (!isRecord(event) || !Number.isSafeInteger(event.frame) || event.frame < 0 || event.frame < lastFrame)
      throw new Error('Input events must have nonnegative, chronological physics frames.');
    const finite = (...values: unknown[]) => values.every(value => typeof value === 'number' && Number.isFinite(value));
    if (['press', 'drag', 'release'].includes(event.type)) {
      if (!Number.isSafeInteger(event.fingerId) || event.fingerId < 0 || event.fingerId > 2147483647 ||
          !finite(event.x, event.y))
        throw new Error('Expected touch events with a valid fingerId and finite x/y coordinates.');
      if (fingers.has(event.fingerId) === (event.type === 'press'))
        throw new Error(`Invalid ${event.type} for finger ${event.fingerId} at frame ${event.frame}.`);
      if (event.type === 'release') fingers.delete(event.fingerId);
      else fingers.add(event.fingerId);
    } else {
      const device = event.device ?? 0;
      if (!Number.isSafeInteger(device) || device < 0 || device > 2147483647)
        throw new Error('Input device must be a nonnegative integer.');
      let stateKey: string | undefined;
      let down: boolean | undefined;
      switch (event.type) {
        case 'key':
          if (!Number.isSafeInteger(event.keycode) || event.keycode < 1 || event.keycode > 2147483647 ||
              typeof event.pressed !== 'boolean')
            throw new Error('Key events require a valid keycode and pressed boolean.');
          stateKey = `key:${device}:${event.keycode}`;
          down = event.pressed;
          break;
        case 'mouse_button':
          if (!Number.isSafeInteger(event.buttonIndex) || event.buttonIndex < 1 || event.buttonIndex > 9 ||
              typeof event.pressed !== 'boolean' || !finite(event.x, event.y))
            throw new Error('Mouse button events require buttonIndex 1-9, pressed, and finite x/y coordinates.');
          stateKey = `mouse:${device}:${event.buttonIndex}`;
          down = event.pressed;
          break;
        case 'mouse_motion':
          if (!finite(event.x, event.y))
            throw new Error('Mouse motion events require finite x/y coordinates.');
          break;
        case 'joypad_button':
          if (!Number.isSafeInteger(event.buttonIndex) || event.buttonIndex < 0 || event.buttonIndex > 21 ||
              typeof event.pressed !== 'boolean')
            throw new Error('Joypad button events require buttonIndex 0-21 and pressed boolean.');
          stateKey = `joypad:${device}:${event.buttonIndex}`;
          down = event.pressed;
          break;
        case 'joypad_axis':
          if (!Number.isSafeInteger(event.axis) || event.axis < 0 || event.axis > 9 ||
              !finite(event.value) || event.value < -1 || event.value > 1)
            throw new Error('Joypad axis events require axis 0-9 and a finite value between -1 and 1.');
          break;
        default:
          throw new Error(`Unsupported input event type: ${String(event.type)}.`);
      }
      if (event.type === 'mouse_button' && event.buttonIndex >= 4 && event.buttonIndex <= 7)
        stateKey = undefined;
      if (stateKey && down !== undefined) {
        if (down ? pressed.has(stateKey) : !pressed.has(stateKey))
          throw new Error(`Invalid ${down ? 'press' : 'release'} state for ${stateKey} at frame ${event.frame}.`);
        if (down) pressed.add(stateKey);
        else pressed.delete(stateKey);
      }
    }
    lastFrame = event.frame;
  }
  lastFrame = -1;
  for (const capture of captures) {
    if (!capture || !Number.isSafeInteger(capture.frame) || capture.frame <= lastFrame)
      throw new Error('Capture frames must be increasing nonnegative integers.');
    if (capture.screenshot !== undefined && typeof capture.screenshot !== 'boolean')
      throw new Error('screenshot must be a boolean.');
    if (capture.nodePaths !== undefined && !Array.isArray(capture.nodePaths))
      throw new Error('nodePaths must be an array of paths relative to the scene root.');
    for (const path of capture.nodePaths ?? []) validatePath(path, 'nodePaths entries');
    lastFrame = capture.frame;
  }

  lastFrame = -1;
  const operators = ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'approximately'];
  for (const assertion of assertions) {
    if (!isRecord(assertion) || !Number.isSafeInteger(assertion.frame) || assertion.frame < 0 || assertion.frame < lastFrame)
      throw new Error('Assertion frames must be nonnegative and chronological.');
    validatePath(assertion.nodePath, 'Assertion nodePath');
    if (typeof assertion.property !== 'string' || !assertion.property ||
        !operators.includes(assertion.operator))
      throw new Error('Assertions require a property and a supported comparison operator.');
    const expected = assertion.expected;
    const primitive = expected === null || typeof expected === 'boolean' || typeof expected === 'string' ||
      typeof expected === 'number' && Number.isFinite(expected);
    const vector = Array.isArray(expected) && (expected.length === 2 || expected.length === 3) &&
      expected.every((value: unknown) => typeof value === 'number' && Number.isFinite(value));
    if (!primitive && !vector)
      throw new Error('Assertion expected values must be finite numbers, strings, booleans, null, or 2D/3D numeric vectors.');
    if (assertion.operator === 'approximately') {
      if (!Number.isFinite(assertion.tolerance) || assertion.tolerance < 0 || typeof expected !== 'number' && !vector)
        throw new Error('approximately requires a numeric or vector expected value and a finite nonnegative tolerance.');
    } else if (['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'].includes(assertion.operator) &&
        typeof expected !== 'number') {
      throw new Error(`${assertion.operator} requires a numeric expected value.`);
    }
    if (assertion.tolerance !== undefined && (!Number.isFinite(assertion.tolerance) || assertion.tolerance < 0))
      throw new Error('Assertion tolerance must be a finite nonnegative number.');
    lastFrame = assertion.frame;
  }
}

export async function handle(this: GodotServer, input: unknown): Promise<CallToolResult> {
  let directory: string | undefined;
  try {
    if (!input || typeof input !== 'object') throw new Error('Expected replay arguments.');
    const args = this.normalizeParameters(input) as {
      projectPath: string; scenePath: string; seed: number; events: ReplayEvent[]; captures: Capture[]; assertions?: Assertion[];
    };
    args.assertions ??= [];
    validateSchedule(args.events, args.captures, args.assertions);
    if (!Number.isSafeInteger(args.seed)) throw new Error('seed must be a safe integer.');
    const root = await requireProject(args.projectPath);
    const scene = await projectFile(root, args.scenePath);
    const engine = await requireGodot(this);
    await importProject(engine, root);
    directory = await mkdtemp(join(tmpdir(), 'godot-replay-'));
    const request = join(directory, 'request.json');
    await writeFile(request, JSON.stringify({
      scenePath: 'res://' + relative(root, scene).split(sep).join('/'),
      seed: args.seed, events: args.events, captures: args.captures, assertions: args.assertions,
    }));
    const render = args.captures.some(capture => capture.screenshot);
    const command = [...(render ? [] : ['--headless']), '--path', root,
      '--script', scriptPath('replay-input.gd'), '--', request];
    const run = await runCommand(engine, command, { timeoutMs: 120000 });
    if (run.timedOut) throw new Error('Replay timed out after 120 seconds.');
    if (run.exitCode !== 0 || /^\s*(?:SCRIPT ERROR|ERROR):/m.test(run.stderr)) {
      throw new Error(run.stderr.trim() || run.stdout.trim() || `Godot exited with code ${run.exitCode}.`);
    }

    const resultPath = join(directory, 'result.json');
    const report = await readFile(resultPath, 'utf8').catch(() => {
      throw new Error('Scene exited before the replay finished. ' + run.stderr.trim());
    });
    const replay = JSON.parse(report) as { captures?: unknown; assertions?: unknown };
    const captures = replay.captures;
    if (!Array.isArray(captures) || captures.length !== args.captures.length)
      throw new Error('Godot returned an incomplete replay.');
    if (!Array.isArray(replay.assertions) || replay.assertions.length !== args.assertions.length)
      throw new Error('Godot returned incomplete frame assertions.');
    const images: CallToolResult['content'] = [];
    for (const [index, capture] of args.captures.entries()) {
      if (capture.screenshot) {
        const png = await readFile(join(directory, `frame-${capture.frame}.png`));
        captures[index].imageContentIndex = images.length + 1;
        images.push({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
      }
    }
    const assertionResults = replay.assertions as { passed: boolean }[];
    const failures = assertionResults.filter(assertion => !assertion.passed);
    const result = jsonResult(args.assertions.length
      ? { seed: args.seed, captures, status: failures.length ? 'failed' : 'passed', assertions: assertionResults, failures }
      : { seed: args.seed, captures });
    if (failures.length) result.isError = true;
    result.content.push(...images);
    return result;
  } catch (error) {
    return this.createErrorResponse(`Replay failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

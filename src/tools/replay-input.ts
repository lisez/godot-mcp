import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { importProject, jsonResult, projectFile, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';

const frameProperty = { type: 'integer', minimum: 0, description: 'Zero-based physics frame.' };

export const definition: Tool = {
  name: 'replay_input',
  description: 'Replay multi-finger touch input in physics frames and capture global node positions and PNGs.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      scenePath: { type: 'string', description: 'Project-relative path of the starting scene.' },
      seed: { type: 'integer', description: 'Seed for the Godot global random number generator.' },
      events: {
        type: 'array',
        description: 'Events in chronological order, with positions in root viewport pixels.',
        items: {
          type: 'object', required: ['frame', 'fingerId', 'type', 'x', 'y'],
          properties: {
            frame: frameProperty, fingerId: { type: 'integer', minimum: 0 },
            type: { enum: ['press', 'drag', 'release'] }, x: { type: 'number' }, y: { type: 'number' },
          },
        },
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
    },
    required: ['projectPath', 'scenePath', 'seed', 'events', 'captures'],
  },
};

interface ReplayEvent {
  frame: number;
  fingerId: number;
  type: 'press' | 'drag' | 'release';
  x: number;
  y: number;
}

interface Capture {
  frame: number;
  nodePaths?: string[];
  screenshot?: boolean;
}

function validateSchedule(events: unknown, captures: unknown): void {
  if (!Array.isArray(events) || !Array.isArray(captures) || !events.length && !captures.length)
    throw new Error('Provide events and captures arrays with at least one event or capture.');
  const fingers = new Set<number>();
  let lastFrame = -1;
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.frame) || event.frame < 0 || event.frame < lastFrame ||
        !Number.isInteger(event.fingerId) || event.fingerId < 0 || event.fingerId > 2147483647 ||
        !['press', 'drag', 'release'].includes(event.type) || !Number.isFinite(event.x) || !Number.isFinite(event.y))
      throw new Error('Expected ordered touch events with a frame, fingerId, type, x and y.');
    if (fingers.has(event.fingerId) === (event.type === 'press'))
      throw new Error(`Invalid ${event.type} for finger ${event.fingerId} at frame ${event.frame}.`);
    if (event.type === 'release') fingers.delete(event.fingerId);
    else fingers.add(event.fingerId);
    lastFrame = event.frame;
  }
  lastFrame = -1;
  for (const capture of captures) {
    if (!capture || !Number.isSafeInteger(capture.frame) || capture.frame <= lastFrame)
      throw new Error('Capture frames must be increasing nonnegative integers.');
    if (capture.screenshot !== undefined && typeof capture.screenshot !== 'boolean')
      throw new Error('screenshot must be a boolean.');
    if (capture.nodePaths !== undefined && (!Array.isArray(capture.nodePaths) ||
        !capture.nodePaths.every((p: unknown) => typeof p === 'string' && p && !p.startsWith('/') && !p.split('/').includes('..'))))
      throw new Error('nodePaths must contain paths relative to the scene root.');
    lastFrame = capture.frame;
  }
}

export async function handle(this: GodotServer, input: unknown): Promise<CallToolResult> {
  let directory: string | undefined;
  try {
    if (!input || typeof input !== 'object') throw new Error('Expected replay arguments.');
    const args = this.normalizeParameters(input) as {
      projectPath: string; scenePath: string; seed: number; events: ReplayEvent[]; captures: Capture[];
    };
    validateSchedule(args.events, args.captures);
    if (!Number.isSafeInteger(args.seed)) throw new Error('seed must be a safe integer.');
    const root = await requireProject(args.projectPath);
    const scene = await projectFile(root, args.scenePath);
    const engine = await requireGodot(this);
    await importProject(engine, root);
    directory = await mkdtemp(join(tmpdir(), 'godot-replay-'));
    const request = join(directory, 'request.json');
    await writeFile(request, JSON.stringify({
      scenePath: 'res://' + relative(root, scene).split(sep).join('/'),
      seed: args.seed, events: args.events, captures: args.captures,
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
    const captures = JSON.parse(report);
    if (!Array.isArray(captures) || captures.length !== args.captures.length)
      throw new Error('Godot returned an incomplete replay.');
    const images: CallToolResult['content'] = [];
    for (const [index, capture] of args.captures.entries()) {
      if (capture.screenshot) {
        const png = await readFile(join(directory, `frame-${capture.frame}.png`));
        captures[index].imageContentIndex = images.length + 1;
        images.push({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
      }
    }
    const result = jsonResult({ seed: args.seed, captures });
    result.content.push(...images);
    return result;
  } catch (error) {
    return this.createErrorResponse(`Replay failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

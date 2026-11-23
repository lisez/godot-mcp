import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { parseDiagnostics, normalizeSceneArguments, resolveScene, resolveSceneReference, sceneError } from './scene-tool-utils.ts';
import { runCommand, scriptPath } from '../tool-runtime.ts';

export const definition: Tool = {
  name: 'preview_scene',
  description: 'Run a fresh Godot process and capture a scene viewport as PNG; requires a working graphical rendering backend.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      scenePath: { type: 'string', description: 'Project-relative scene to preview.' },
      previewEntryScene: { type: 'string', description: 'Optional project-relative entry scene to preview instead of scenePath.' },
      width: { type: 'integer', minimum: 1, maximum: 4096, default: 1280 },
      height: { type: 'integer', minimum: 1, maximum: 4096, default: 720 },
      captureFrame: { type: 'integer', minimum: 0, maximum: 100000, default: 1, description: 'Zero-based rendered frame index after scene installation; 0 is the first process/physics update.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647, default: 60000 },
      seed: { type: 'integer', description: 'Optional deterministic global RNG seed; this does not make all project behavior deterministic.' },
    },
    required: ['projectPath', 'scenePath'],
  },
};

function failure(message: string, stdout = '', stderr = '', diagnostics: ReturnType<typeof parseDiagnostics> = []): CallToolResult {
  const data = { error: message, stdout, stderr, diagnostics };
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

function pngSize(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Godot returned invalid PNG data.');
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export async function handle(this: GodotServer, raw: unknown) {
  try {
    const args = normalizeSceneArguments(this, raw);
    const { root, resourcePath, godot } = await resolveScene(this, args.projectPath, args.scenePath);
    const previewPath = args.previewEntryScene === undefined
      ? resourcePath
      : await resolveSceneReference(root, args.previewEntryScene, 'previewEntryScene');
    const width = args.width ?? 1280;
    const height = args.height ?? 720;
    const captureFrame = args.captureFrame ?? 1;
    const timeoutMs = args.timeoutMs ?? 60_000;
    const seed = args.seed;
    if (!Number.isSafeInteger(width) || width < 1 || width > 4096 ||
        !Number.isSafeInteger(height) || height < 1 || height > 4096 || width * height > 16_777_216) {
      throw new Error('width and height must be positive integers no greater than 4096 or 16,777,216 total pixels.');
    }
    if (!Number.isSafeInteger(captureFrame) || captureFrame < 0 || captureFrame > 100_000) {
      throw new Error('captureFrame must be an integer between 0 and 100000.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error('timeoutMs must be a positive 32-bit integer.');
    }
    if (seed !== undefined && !Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer.');

    const imported = await runCommand(godot, ['--headless', '--path', root, '--import'], { timeoutMs: 120_000 });
    const importDiagnostics = parseDiagnostics(imported.stdout + '\n' + imported.stderr);
    if (imported.timedOut || imported.exitCode !== 0 || importDiagnostics.some(item => item.severity === 'error')) {
      return failure(
        imported.timedOut ? 'Project import timed out.' : 'Project import failed.',
        imported.stdout,
        imported.stderr,
        importDiagnostics,
      );
    }
    const result = await runCommand(godot, [
      '--path', root, '--script', scriptPath('preview-scene.gd'), '--',
      Buffer.from(JSON.stringify({ scenePath: previewPath, width, height, captureFrame, seed })).toString('base64'),
    ], { cwd: root, timeoutMs });
    const diagnostics = [...importDiagnostics, ...parseDiagnostics(result.stdout + '\n' + result.stderr)];
    const marker = 'GODOT_MCP_PREVIEW_SCENE=';
    const reportLine = result.stdout.split(/\r?\n/).findLast(line => line.startsWith(marker));
    if (result.timedOut) return failure('Scene preview timed out.', imported.stdout + result.stdout, imported.stderr + result.stderr, diagnostics);
    if (!reportLine) {
      return failure(
        'Scene preview produced no screenshot report. A graphical renderer/display is required; headless-only hosts cannot capture previews.',
        imported.stdout + result.stdout,
        imported.stderr + result.stderr,
        diagnostics,
      );
    }
    const report = JSON.parse(reportLine.slice(marker.length));
    if (result.exitCode !== 0 || report.error || diagnostics.some(item => item.severity === 'error')) {
      return failure(
        report.error ?? 'Godot reported an error while previewing the scene.',
        imported.stdout + result.stdout,
        imported.stderr + result.stderr,
        diagnostics,
      );
    }
    if (typeof report.png !== 'string') {
      return failure('Godot preview report did not include a screenshot.', imported.stdout + result.stdout, imported.stderr + result.stderr, diagnostics);
    }
    if (report.captureFrame !== captureFrame) {
      return failure(
        `Godot captured frame ${String(report.captureFrame)} instead of requested zero-based frame ${captureFrame}.`,
        imported.stdout + result.stdout,
        imported.stderr + result.stderr,
        diagnostics,
      );
    }
    if (typeof report.pixelHash !== 'string' || !/^[a-f0-9]{64}$/.test(report.pixelHash)) {
      return failure(
        'Godot preview report did not include a valid rendered-pixel fingerprint.',
        imported.stdout + result.stdout,
        imported.stderr + result.stderr,
        diagnostics,
      );
    }
    const image = Buffer.from(report.png, 'base64');
    const actualSize = pngSize(image);
    if (actualSize.width !== width || actualSize.height !== height) {
      return failure(
        `Viewport screenshot dimensions ${actualSize.width}x${actualSize.height} did not match requested ${width}x${height}.`,
        imported.stdout + result.stdout,
        imported.stderr + result.stderr,
        diagnostics,
      );
    }
    const metadata = {
      scenePath: resourcePath,
      previewedScenePath: previewPath,
      width: actualSize.width,
      height: actualSize.height,
      captureFrame,
      frameTiming: 'Frame indices are zero-based: frame 0 is the first process/physics update after scene installation. Capture occurs after the requested frame is rendered.',
      pixelHash: report.pixelHash,
      dimensions: 'PNG dimensions are the root viewport dimensions, not necessarily the outer window dimensions.',
      stdout: imported.stdout + result.stdout.replace(reportLine, ''),
      stderr: imported.stderr + result.stderr,
      diagnostics,
      sideEffects: 'A fresh project process executes project initialization and scene scripts; this may have project-defined side effects. The active run_project process is not modified.',
    };
    return {
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', mimeType: 'image/png', data: image.toString('base64') },
      ],
      structuredContent: metadata,
    };
  } catch (error) {
    return sceneError(this, error);
  }
}

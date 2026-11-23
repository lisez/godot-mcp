import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { jsonResult, projectFile, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';

export type SceneServer = GodotServer;

export function normalizeSceneArguments(server: SceneServer, raw: unknown): Record<string, any> {
  const normalized = server.normalizeParameters(raw ?? {}) as Record<string, any>;
  const aliases: Record<string, string> = {
    project_path: 'projectPath',
    scene_path: 'scenePath',
    timeout_ms: 'timeoutMs',
    expected_original_fingerprint: 'expectedOriginalFingerprint',
    capture_frame: 'captureFrame',
    preview_entry_scene: 'previewEntryScene',
    viewport_width: 'width',
    viewport_height: 'height',
    deterministic_seed: 'seed',
  };
  for (const [snake, camel] of Object.entries(aliases)) {
    if (normalized[camel] === undefined && normalized[snake] !== undefined) normalized[camel] = normalized[snake];
  }
  return normalized;
}

export async function resolveScene(server: SceneServer, projectPath: unknown, scenePath: unknown) {
  const root = await requireProject(projectPath);
  const sceneFile = await projectFile(root, scenePath);
  if (!sceneFile.toLowerCase().endsWith('.tscn')) throw new Error('scenePath must refer to a .tscn file.');
  return {
    root,
    sceneFile,
    resourcePath: 'res://' + relative(root, sceneFile).split(sep).join('/'),
    godot: await requireGodot(server),
  };
}

export async function resolveSceneReference(root: string, value: unknown, name: string): Promise<string> {
  const file = await projectFile(root, value);
  if (!file.toLowerCase().endsWith('.tscn')) throw new Error(`${name} must refer to a project-relative .tscn file.`);
  return 'res://' + relative(root, file).split(sep).join('/');
}

export function encodeRequest(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

export async function callGodotHelper(
  godot: string,
  root: string,
  helper: string,
  request: unknown,
  marker: string,
  timeoutMs = 60_000,
) {
  const importResult = await runCommand(godot, ['--headless', '--path', root, '--import'], { timeoutMs: 120_000 });
  const importOutput = importResult.stdout + '\n' + importResult.stderr;
  const importDiagnostics = parseDiagnostics(importOutput);
  if (importResult.timedOut || importResult.exitCode !== 0 || importDiagnostics.some(item => item.severity === 'error')) {
    return {
      ok: false as const,
      error: `Project import ${importResult.timedOut ? 'timed out' : 'failed'}.`,
      stdout: importResult.stdout,
      stderr: importResult.stderr,
      diagnostics: importDiagnostics,
    };
  }

  const result = await runCommand(godot, [
    '--headless', '--path', root, '--script', scriptPath(helper), '--', encodeRequest(request),
  ], { timeoutMs });
  const output = result.stdout + '\n' + result.stderr;
  const diagnostics = [...importDiagnostics, ...parseDiagnostics(output)];
  const reportLine = result.stdout.split(/\r?\n/).findLast(line => line.startsWith(marker));
  if (!reportLine || result.timedOut) {
    return {
      ok: false as const,
      error: result.timedOut ? 'Godot helper timed out.' : 'Godot helper did not return a complete report.',
      stdout: importResult.stdout + result.stdout,
      stderr: importResult.stderr + result.stderr,
      diagnostics,
    };
  }
  let data: any;
  try {
    data = JSON.parse(reportLine.slice(marker.length));
  } catch (error) {
    return {
      ok: false as const,
      error: `Godot helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      stdout: importResult.stdout + result.stdout,
      stderr: importResult.stderr + result.stderr,
      diagnostics,
    };
  }
  const failed = result.exitCode !== 0 || !!data.error || diagnostics.some(item => item.severity === 'error');
  return {
    ok: !failed as true | false,
    error: failed ? data.error ?? 'Godot reported an error while processing the scene.' : undefined,
    data,
    stdout: importResult.stdout + result.stdout,
    stderr: importResult.stderr + result.stderr,
    diagnostics,
  };
}

export function parseDiagnostics(output: string) {
  const result: { severity: 'error' | 'warning'; message: string; file?: string; line?: number }[] = [];
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = /^\s*(SCRIPT ERROR|ERROR|WARNING):\s*(.*)/.exec(line);
    if (!match) continue;
    const location = /\((res:\/\/.+?):(\d+)\)/.exec(match[2]) ?? /\(([^()]+\.tscn):(\d+)\)/.exec(match[2]);
    result.push({
      severity: match[1] === 'WARNING' ? 'warning' : 'error',
      message: match[2],
      ...(location ? { file: location[1], line: Number(location[2]) } : {}),
    });
  }
  return result;
}

export async function projectFingerprint(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export function sceneError(server: SceneServer, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return server.createErrorResponse(message);
}

export function toolReport(data: Record<string, unknown>, isError = false): CallToolResult {
  return jsonResult(data, isError);
}

export async function createSceneStagePath(root: string, target: string): Promise<{ absolute: string; relative: string }> {
  const path = dirname(target);
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `.godot-mcp-scene-${randomUUID()}.tscn`;
    const absolute = path + (path.endsWith(sep) ? '' : sep) + name;
    try {
      await stat(absolute);
    } catch {
      return { absolute, relative: relative(root, absolute).split(sep).join('/') };
    }
  }
  throw new Error('Could not allocate a unique same-directory scene staging path.');
}

export async function commitSceneStage(
  stage: string,
  target: string,
  expectedFingerprint: string,
): Promise<void> {
  const current = await projectFingerprint(target);
  if (current !== expectedFingerprint) throw new Error('Scene changed after preview; the staged edit was not applied.');
  await rename(stage, target);
}

export async function removeSceneStage(path: string): Promise<void> {
  await rm(path, { force: true });
}

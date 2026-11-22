import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from './index.ts';

export async function requireProject(projectPath: unknown): Promise<string> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('Provide a projectPath containing project.godot.');
  }
  const root = await realpath(projectPath);
  if (!(await stat(join(root, 'project.godot'))).isFile()) {
    throw new Error('project.godot must be a file.');
  }
  return root;
}

export async function projectFile(root: string, path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Provide a project-relative file path.');
  }
  const local = path.replace(/^res:\/\//, '');
  if (isAbsolute(local)) throw new Error('Expected a project-relative path.');
  const file = await realpath(resolve(root, local));
  const rel = relative(root, file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('File must be inside the project.');
  }
  if (!(await stat(file)).isFile()) throw new Error('Expected a file: ' + path);
  return file;
}

export async function requireGodot(server: GodotServer): Promise<string> {
  if (!server.godotPath) await server.detectGodotPath();
  if (!server.godotPath) throw new Error('Set GODOT_PATH to the Godot executable.');
  return server.godotPath;
}

export function scriptPath(name: string): string {
  return join(import.meta.dirname, 'scripts', name);
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function runCommand(file: string, args: string[], options: {
  cwd?: string;
  timeoutMs?: number;
} = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('timeoutMs must be a positive 32-bit integer.');
  }
  return new Promise((resolveResult, reject) => {
    let timedOut = false;
    const child = execFile(file, args, {
      cwd: options.cwd,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error && typeof error.code === 'string') {
        reject(error);
      } else {
        resolveResult({ stdout, stderr, exitCode: child.exitCode, timedOut });
      }
    });
    // Commands such as adb install and Godot's debugger must never wait on MCP stdin.
    child.stdin?.end();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // A descendant can retain inherited pipes after the timed-out process exits.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, timeoutMs);
  });
}

export async function importProject(engine: string, project: string): Promise<void> {
  const result = await runCommand(engine, ['--headless', '--path', project, '--import'], { timeoutMs: 120_000 });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error('Project import ' + (result.timedOut ? 'timed out.' : 'failed.') + '\n' + (result.stderr || result.stdout));
  }
}

export function jsonResult(data: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

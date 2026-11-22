import { stripVTControlCharacters } from 'node:util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { jsonResult, projectFile, requireGodot, requireProject, runCommand } from '../tool-runtime.ts';

export const definition: Tool = {
  name: 'run_tests',
  description: 'Run a project GDScript test entry point using Godot 4 headless. Report assertions even when the script exits successfully.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      scriptPath: { type: 'string', description: 'Project-relative .gd script runnable with --script.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647, default: 60000 },
    },
    required: ['projectPath', 'scriptPath'],
  },
};

interface Diagnostic {
  message: string;
  file?: string;
  line?: number;
  stack: string[];
}

function diagnostics(output: string): Diagnostic[] {
  const result: Diagnostic[] = [];
  let current: Diagnostic | undefined;
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const error = /^\s*(?:SCRIPT ERROR|ERROR):\s*(.*)/.exec(line);
    if (error) {
      current = { message: error[1], stack: [] };
      result.push(current);
    } else if (current && /^\s*(?:at:|GDScript backtrace|\[\d+\])/.test(line)) {
      current.stack.push(line.trim());
      const location = /\((res:\/\/.+?):(\d+)\)/.exec(line);
      if (location && !current.file) {
        current.file = location[1];
        current.line = Number(location[2]);
      }
    } else {
      current = undefined;
    }
  }
  return result;
}

export async function handle(this: GodotServer, raw: any) {
  try {
    const { projectPath, scriptPath, timeoutMs = 60_000 } = this.normalizeParameters(raw ?? {});
    const root = await requireProject(projectPath);
    const script = await projectFile(root, scriptPath);
    if (!/\.gd$/i.test(script)) throw new Error('scriptPath must refer to a GDScript (.gd) file.');
    const godot = await requireGodot(this);
    const start = performance.now();
    const { stdout, stderr, timedOut, exitCode } = await runCommand(
      godot, ['--headless', '--path', root, '--script', script], { timeoutMs }
    );
    const errors = [...diagnostics(stdout), ...diagnostics(stderr)];
    const status = timedOut ? 'timed_out' : exitCode !== 0 || errors.length ? 'failed' : 'passed';
    return jsonResult({
      status, exitCode, durationMs: Math.round(performance.now() - start),
      diagnostics: errors, stdout, stderr,
    }, status !== 'passed');
  } catch (error) {
    return this.createErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

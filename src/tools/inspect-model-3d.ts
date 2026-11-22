import { relative, sep } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { importProject, jsonResult, projectFile, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';

export const definition: Tool = {
  name: 'inspect_model_3d',
  description: 'Inspect a Godot 4 scene or imported GLB and measure between two Node3D origins in model-root coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      modelPath: { type: 'string', description: 'Project-relative .glb or .tscn path.' },
      fromNode: { type: 'string', description: 'Root-relative node path, or . for the root. Supply both endpoints.' },
      toNode: { type: 'string', description: 'Root-relative path of the destination node.' },
    },
    required: ['projectPath', 'modelPath'],
  },
};

export async function handle(this: GodotServer, raw: any) {
  try {
    const { projectPath, modelPath, fromNode, toNode } = this.normalizeParameters(raw ?? {});
    const root = await requireProject(projectPath);
    const file = await projectFile(root, modelPath);
    if (!/\.(glb|tscn)$/i.test(file)) throw new Error('modelPath must refer to a .glb or .tscn file.');
    const endpoints = [fromNode, toNode];
    if (endpoints.some(node => node !== undefined) &&
        !endpoints.every(node => typeof node === 'string' && node.length > 0)) {
      throw new Error('Provide both fromNode and toNode as root-relative node paths.');
    }

    const godot = await requireGodot(this);
    const resource = 'res://' + relative(root, file).split(sep).join('/');
    // A TSCN can instance a GLB or reference other imported dependencies.
    await importProject(godot, root);
    const result = await runCommand(godot, [
      '--headless', '--path', root, '--script', scriptPath('inspect-model-3d.gd'),
      '--', resource, ...(fromNode === undefined ? [] : endpoints),
    ]);
    const marker = 'GODOT_MCP_MODEL=';
    const report = result.stdout.split(/\r?\n/).findLast(line => line.startsWith(marker));
    if (!report || result.timedOut) {
      throw new Error((result.timedOut ? 'Model inspection timed out.' : 'Model inspection failed.') + '\n' + result.stderr);
    }
    const data = JSON.parse(report.slice(marker.length));
    const output = result.stdout.replace(report, '') + '\n' + result.stderr;
    if (/^\s*(?:SCRIPT ERROR|ERROR):/m.test(output)) {
      return jsonResult({ error: data.error ?? 'Godot reported errors while loading the model.', diagnostics: output.trim() }, true);
    }
    return jsonResult(data, result.exitCode !== 0 || !!data.error);
  } catch (error) {
    return this.createErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

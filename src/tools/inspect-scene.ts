import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { callGodotHelper, normalizeSceneArguments, resolveScene, sceneError, toolReport } from './scene-tool-utils.ts';

export const definition: Tool = {
  name: 'inspect_scene',
  description: 'Inspect the serialized, file-local node tree and connections of a Godot scene without treating it as a runtime snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      scenePath: { type: 'string', description: 'Project-relative .tscn path.' },
    },
    required: ['projectPath', 'scenePath'],
  },
};

export async function handle(this: GodotServer, raw: unknown) {
  try {
    const args = normalizeSceneArguments(this, raw);
    const { root, resourcePath, godot } = await resolveScene(this, args.projectPath, args.scenePath);
    const result = await callGodotHelper(godot, root, 'inspect-scene.gd', { scenePath: resourcePath }, 'GODOT_MCP_INSPECT_SCENE=');
    if (!result.ok) {
      return toolReport({
        scenePath: resourcePath,
        error: result.error,
        diagnostics: result.diagnostics,
        stdout: result.stdout,
        stderr: result.stderr,
      }, true);
    }
    return toolReport({
      ...result.data,
      diagnostics: result.diagnostics,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (error) {
    return sceneError(this, error);
  }
}

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'get_debug_output',
  description: 'Get the current debug output and errors',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function handle(this: GodotServer, _args: unknown) {
  if (!this.activeProcess) {
    return this.createErrorResponse(
      'No active Godot process.',
      [
        'Use run_project to start a Godot project first',
        'Check if the Godot process crashed unexpectedly',
      ]
    );
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            output: this.activeProcess.output,
            errors: this.activeProcess.errors,
          },
          null,
          2
        ),
      },
    ],
  };
}

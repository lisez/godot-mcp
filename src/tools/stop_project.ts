import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.js';

export const definition: Tool = {
  name: 'stop_project',
  description: 'Stop the currently running Godot project',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function handle(this: GodotServer, _args: unknown) {
  if (!this.activeProcess) {
    return this.createErrorResponse(
      'No active Godot process to stop.',
      [
        'Use run_project to start a Godot project first',
        'The process may have already terminated',
      ]
    );
  }

  this.logDebug('Stopping active Godot process');
  this.activeProcess.process.kill();
  const output = this.activeProcess.output;
  const errors = this.activeProcess.errors;
  this.activeProcess = null;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Godot project stopped',
            finalOutput: output,
            finalErrors: errors,
          },
          null,
          2
        ),
      },
    ],
  };
}

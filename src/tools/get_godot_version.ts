import { execFileAsync } from '../process.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'get_godot_version',
  description: 'Get the installed Godot version',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function handle(this: GodotServer, _args: unknown) {
  try {
    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        return this.createErrorResponse(
          'Could not find a valid Godot executable path',
          [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]
        );
      }
    }

    this.logDebug('Getting Godot version');
    const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
    return {
      content: [
        {
          type: 'text',
          text: stdout.trim(),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return this.createErrorResponse(
      `Failed to get Godot version: ${errorMessage}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]
    );
  }
}

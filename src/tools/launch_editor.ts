import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.js';

export const definition: Tool = {
  name: 'launch_editor',
  description: 'Launch Godot editor for a specific project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the Godot project directory',
      },
    },
    required: ['projectPath'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.projectPath) {
    return this.createErrorResponse(
      'Project path is required',
      ['Provide a valid path to a Godot project directory']
    );
  }

  if (!this.validatePath(args.projectPath)) {
    return this.createErrorResponse(
      'Invalid project path',
      ['Provide a valid path without ".." or other potentially unsafe characters']
    );
  }

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

    // Check if the project directory exists and contains a project.godot file
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
    const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
      stdio: 'pipe',
    });

    process.on('error', (err: Error) => {
      console.error('Failed to start Godot editor:', err);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Godot editor launched successfully for project at ${args.projectPath}.`,
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return this.createErrorResponse(
      `Failed to launch Godot editor: ${errorMessage}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

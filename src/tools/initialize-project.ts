import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'initialize_project',
  description: 'Initialize a Godot project by creating an empty project.godot in an existing folder',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the existing folder where project.godot should be created',
      },
    },
    required: ['projectPath'],
  },
};

export async function handle(this: GodotServer, args: any) {
  args = this.normalizeParameters(args);

  if (!args.projectPath) {
    return this.createErrorResponse(
      'Project path is required',
      ['Provide the path to an existing target folder']
    );
  }

  if (!this.validatePath(args.projectPath)) {
    return this.createErrorResponse(
      'Invalid project path',
      ['Provide a valid path without ".." or other potentially unsafe characters']
    );
  }

  try {
    const target = await stat(args.projectPath);
    if (!target.isDirectory()) {
      return this.createErrorResponse(
        `Target is not a directory: ${args.projectPath}`,
        ['Provide the path to an existing folder']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    const file = await open(projectFile, 'a');
    await file.close();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ projectFile }, null, 2),
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return this.createErrorResponse(
      `Failed to initialize project: ${errorMessage}`,
      ['Verify the target folder exists and is writable']
    );
  }
}

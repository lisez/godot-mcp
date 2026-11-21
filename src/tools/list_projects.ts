import { existsSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'list_projects',
  description: 'List Godot projects in a directory',
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Directory to search for Godot projects',
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to search recursively (default: false)',
      },
    },
    required: ['directory'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.directory) {
    return this.createErrorResponse(
      'Directory is required',
      ['Provide a valid directory path to search for Godot projects']
    );
  }

  if (!this.validatePath(args.directory)) {
    return this.createErrorResponse(
      'Invalid directory path',
      ['Provide a valid path without ".." or other potentially unsafe characters']
    );
  }

  try {
    this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
    if (!existsSync(args.directory)) {
      return this.createErrorResponse(
        `Directory does not exist: ${args.directory}`,
        ['Provide a valid directory path that exists on the system']
      );
    }

    const recursive = args.recursive === true;
    const projects = this.findGodotProjects(args.directory, recursive);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(projects, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to list projects: ${error?.message || 'Unknown error'}`,
      [
        'Ensure the directory exists and is accessible',
        'Check if you have permission to read the directory',
      ]
    );
  }
}

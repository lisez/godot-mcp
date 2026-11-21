import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'create_scene',
  description: 'Create a new Godot scene file',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the Godot project directory',
      },
      scenePath: {
        type: 'string',
        description: 'Path where the scene file will be saved (relative to project)',
      },
      rootNodeType: {
        type: 'string',
        description: 'Type of the root node (e.g., Node2D, Node3D)',
      },
    },
    required: ['projectPath', 'scenePath'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.projectPath || !args.scenePath) {
    return this.createErrorResponse(
      'Project path and scene path are required',
      ['Provide valid paths for both the project and the scene']
    );
  }

  if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
    return this.createErrorResponse(
      'Invalid path',
      ['Provide valid paths without ".." or other potentially unsafe characters']
    );
  }

  const rootNodeType = args.rootNodeType || 'Node2D';
  if (!this.validateClassName(rootNodeType)) {
    return this.createErrorResponse(
      'Invalid rootNodeType',
      ['rootNodeType must be a built-in Godot class name (no paths, no file extensions)']
    );
  }

  try {
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

    // Prepare parameters for the operation (already in camelCase)
    const params = {
      scenePath: args.scenePath,
      rootNodeType,
    };

    // Execute the operation
    const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to create scene: ${stderr}`,
        [
          'Check if the root node type is valid',
          'Ensure you have write permissions to the scene path',
          'Verify the scene path is valid',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to create scene: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

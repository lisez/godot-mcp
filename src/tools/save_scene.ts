import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.js';

export const definition: Tool = {
  name: 'save_scene',
  description: 'Save changes to a scene file',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the Godot project directory',
      },
      scenePath: {
        type: 'string',
        description: 'Path to the scene file (relative to project)',
      },
      newPath: {
        type: 'string',
        description: 'Optional: New path to save the scene to (for creating variants)',
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
      'Missing required parameters',
      ['Provide projectPath and scenePath']
    );
  }

  if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
    return this.createErrorResponse(
      'Invalid path',
      ['Provide valid paths without ".." or other potentially unsafe characters']
    );
  }

  // If newPath is provided, validate it
  if (args.newPath && !this.validatePath(args.newPath)) {
    return this.createErrorResponse(
      'Invalid new path',
      ['Provide a valid new path without ".." or other potentially unsafe characters']
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

    // Check if the scene file exists
    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return this.createErrorResponse(
        `Scene file does not exist: ${args.scenePath}`,
        [
          'Ensure the scene path is correct',
          'Use create_scene to create a new scene first',
        ]
      );
    }

    // Prepare parameters for the operation (already in camelCase)
    const params: any = {
      scenePath: args.scenePath,
    };

    // Add optional parameters
    if (args.newPath) {
      params.newPath = args.newPath;
    }

    // Execute the operation
    const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to save scene: ${stderr}`,
        [
          'Check if the scene file is valid',
          'Ensure you have write permissions to the output path',
          'Verify the scene can be properly packed',
        ]
      );
    }

    const savePath = args.newPath || args.scenePath;
    return {
      content: [
        {
          type: 'text',
          text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to save scene: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

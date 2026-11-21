import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'load_sprite',
  description: 'Load a sprite into a Sprite2D node',
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
      nodePath: {
        type: 'string',
        description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
      },
      texturePath: {
        type: 'string',
        description: 'Path to the texture file (relative to project)',
      },
    },
    required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
    return this.createErrorResponse(
      'Missing required parameters',
      ['Provide projectPath, scenePath, nodePath, and texturePath']
    );
  }

  if (
    !this.validatePath(args.projectPath) ||
    !this.validatePath(args.scenePath) ||
    !this.validatePath(args.nodePath) ||
    !this.validatePath(args.texturePath)
  ) {
    return this.createErrorResponse(
      'Invalid path',
      ['Provide valid paths without ".." or other potentially unsafe characters']
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

    // Check if the texture file exists
    const texturePath = join(args.projectPath, args.texturePath);
    if (!existsSync(texturePath)) {
      return this.createErrorResponse(
        `Texture file does not exist: ${args.texturePath}`,
        [
          'Ensure the texture path is correct',
          'Upload or create the texture file first',
        ]
      );
    }

    // Prepare parameters for the operation (already in camelCase)
    const params = {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      texturePath: args.texturePath,
    };

    // Execute the operation
    const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to load sprite: ${stderr}`,
        [
          'Check if the node path is correct',
          'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
          'Verify the texture file is a valid image format',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to load sprite: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

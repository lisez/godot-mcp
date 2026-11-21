import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'export_mesh_library',
  description: 'Export a scene as a MeshLibrary resource',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the Godot project directory',
      },
      scenePath: {
        type: 'string',
        description: 'Path to the scene file (.tscn) to export',
      },
      outputPath: {
        type: 'string',
        description: 'Path where the mesh library (.res) will be saved',
      },
      meshItemNames: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Optional: Names of specific mesh items to include (defaults to all)',
      },
    },
    required: ['projectPath', 'scenePath', 'outputPath'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.projectPath || !args.scenePath || !args.outputPath) {
    return this.createErrorResponse(
      'Missing required parameters',
      ['Provide projectPath, scenePath, and outputPath']
    );
  }

  if (
    !this.validatePath(args.projectPath) ||
    !this.validatePath(args.scenePath) ||
    !this.validatePath(args.outputPath)
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

    // Prepare parameters for the operation (already in camelCase)
    const params: any = {
      scenePath: args.scenePath,
      outputPath: args.outputPath,
    };

    // Add optional parameters
    if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
      params.meshItemNames = args.meshItemNames;
    }

    // Execute the operation
    const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${stderr}`,
        [
          'Check if the scene contains valid 3D meshes',
          'Ensure the output path is valid',
          'Verify the scene file is valid',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

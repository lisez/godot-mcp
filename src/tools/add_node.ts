import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.js';

export const definition: Tool = {
  name: 'add_node',
  description: 'Add a node to an existing scene',
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
      parentNodePath: {
        type: 'string',
        description: 'Path to the parent node (e.g., "root" or "root/Player")',
      },
      nodeType: {
        type: 'string',
        description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
      },
      nodeName: {
        type: 'string',
        description: 'Name for the new node',
      },
      properties: {
        type: 'object',
        description: 'Optional properties to set on the node',
      },
    },
    required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
    return this.createErrorResponse(
      'Missing required parameters',
      ['Provide projectPath, scenePath, nodeType, and nodeName']
    );
  }

  if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
    return this.createErrorResponse(
      'Invalid path',
      ['Provide valid paths without ".." or other potentially unsafe characters']
    );
  }

  if (!this.validateClassName(args.nodeType)) {
    return this.createErrorResponse(
      'Invalid nodeType',
      ['nodeType must be a built-in Godot class name (no paths, no file extensions)']
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
      nodeType: args.nodeType,
      nodeName: args.nodeName,
    };

    // Add optional parameters
    if (args.parentNodePath) {
      params.parentNodePath = args.parentNodePath;
    }

    if (args.properties) {
      params.properties = args.properties;
    }

    // Execute the operation
    const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to add node: ${stderr}`,
        [
          'Check if the node type is valid',
          'Ensure the parent node path exists',
          'Verify the scene file is valid',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to add node: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

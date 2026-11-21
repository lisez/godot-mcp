import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileAsync } from '../process.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.js';

export const definition: Tool = {
  name: 'get_uid',
  description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the Godot project directory',
      },
      filePath: {
        type: 'string',
        description: 'Path to the file (relative to project) for which to get the UID',
      },
    },
    required: ['projectPath', 'filePath'],
  },
};

export async function handle(this: GodotServer, args: any) {
  // Normalize parameters to camelCase
  args = this.normalizeParameters(args);
  
  if (!args.projectPath || !args.filePath) {
    return this.createErrorResponse(
      'Missing required parameters',
      ['Provide projectPath and filePath']
    );
  }

  if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
    return this.createErrorResponse(
      'Invalid path',
      ['Provide valid paths without ".." or other potentially unsafe characters']
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

    // Check if the file exists
    const filePath = join(args.projectPath, args.filePath);
    if (!existsSync(filePath)) {
      return this.createErrorResponse(
        `File does not exist: ${args.filePath}`,
        ['Ensure the file path is correct']
      );
    }

    // Get Godot version to check if UIDs are supported
    const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
    const version = versionOutput.trim();

    if (!this.isGodot44OrLater(version)) {
      return this.createErrorResponse(
        `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
        [
          'Upgrade to Godot 4.4 or later to use UIDs',
          'Use resource paths instead of UIDs for this version of Godot',
        ]
      );
    }

    // Prepare parameters for the operation (already in camelCase)
    const params = {
      filePath: args.filePath,
    };

    // Execute the operation
    const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to get UID: ${stderr}`,
        [
          'Check if the file is a valid Godot resource',
          'Ensure the file path is correct',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `UID for ${args.filePath}: ${stdout.trim()}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to get UID: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

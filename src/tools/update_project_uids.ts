import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileAsync } from '../process.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'update_project_uids',
  description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
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

    const params = {
      projectPath: 'res://',
    };

    const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

    if (stderr && stderr.includes('Failed to')) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${stderr}`,
        [
          'Check if the project is valid',
          'Ensure you have write permissions to the project directory',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

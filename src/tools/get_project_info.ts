import { join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileAsync } from '../process.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'get_project_info',
  description: 'Retrieve metadata about a Godot project',
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

    this.logDebug(`Getting project info for: ${args.projectPath}`);

    // Get Godot version
    const execOptions = { timeout: 10000 }; // 10 second timeout
    const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);

    // Get project structure using the recursive method
    const projectStructure = await this.getProjectStructureAsync(args.projectPath);

    // Extract project name from project.godot file
    let projectName = basename(args.projectPath);
    try {
      const projectFileContent = readFileSync(projectFile, 'utf8');
      const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
      if (configNameMatch && configNameMatch[1]) {
        projectName = configNameMatch[1];
        this.logDebug(`Found project name in config: ${projectName}`);
      }
    } catch (error) {
      this.logDebug(`Error reading project file: ${error}`);
      // Continue with default project name if extraction fails
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              name: projectName,
              path: args.projectPath,
              godotVersion: stdout.trim(),
              structure: projectStructure,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to get project info: ${error?.message || 'Unknown error'}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

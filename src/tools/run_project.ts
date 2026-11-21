import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';

export const definition: Tool = {
  name: 'run_project',
  description: 'Run the Godot project and capture output',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: 'Path to the Godot project directory',
      },
      scene: {
        type: 'string',
        description: 'Optional: Specific scene to run',
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

    // Kill any existing process
    if (this.activeProcess) {
      this.logDebug('Killing existing Godot process before starting a new one');
      this.activeProcess.process.kill();
    }

    const cmdArgs = ['-d', '--path', args.projectPath];
    if (args.scene && this.validatePath(args.scene)) {
      this.logDebug(`Adding scene parameter: ${args.scene}`);
      cmdArgs.push(args.scene);
    }

    this.logDebug(`Running Godot project: ${args.projectPath}`);
    const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
    const output: string[] = [];
    const errors: string[] = [];

    process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      output.push(...lines);
      lines.forEach((line: string) => {
        if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
      });
    });

    process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      errors.push(...lines);
      lines.forEach((line: string) => {
        if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
      });
    });

    process.on('exit', (code: number | null) => {
      this.logDebug(`Godot process exited with code ${code}`);
      if (this.activeProcess && this.activeProcess.process === process) {
        this.activeProcess = null;
      }
    });

    process.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      if (this.activeProcess && this.activeProcess.process === process) {
        this.activeProcess = null;
      }
    });

    this.activeProcess = { process, output, errors };

    return {
      content: [
        {
          type: 'text',
          text: `Godot project started in debug mode. Use get_debug_output to see output.`,
        },
      ],
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return this.createErrorResponse(
      `Failed to run Godot project: ${errorMessage}`,
      [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]
    );
  }
}

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { jsonResult, projectFile, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';
import { diagnostics, runTestScript } from './run-tests.ts';
import { discoverTests } from './test-discovery.ts';

export const definition: Tool = {
  name: 'validate_project',
  description: 'Validate a Godot project and run discoverable standalone tests.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      testPaths: { type: 'array', items: { type: 'string' }, description: 'Explicit test scripts, in addition to discovered entries.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647, default: 60000 },
    },
    required: ['projectPath'],
  },
};

async function projectSources(root: string) {
  const scripts: string[] = [];
  const extensions: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (dir !== root && entries.some(entry => entry.name === '.gdignore')) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === '.godot' || entry.name === '.git') continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const path = relative(root, file).split(sep).join('/');
        if (entry.name.endsWith('.gd')) scripts.push(path);
        if (entry.name.endsWith('.gdextension')) extensions.push(path);
      }
    }
  }
  await visit(root);
  scripts.sort();
  extensions.sort();
  return { scripts, extensions };
}

export async function handle(this: GodotServer, input: unknown) {
  try {
    const args = this.normalizeParameters(input ?? {});
    const timeoutMs = args.timeoutMs ?? 60000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
      throw new Error('timeoutMs must be a positive 32-bit integer.');
    if (args.testPaths !== undefined && (!Array.isArray(args.testPaths) ||
        !args.testPaths.every((path: unknown) => typeof path === 'string')))
      throw new Error('testPaths must be an array of project-relative paths.');
    const root = await requireProject(args.projectPath);
    const godot = await requireGodot(this);
    const sources = await projectSources(root);
    const candidates = await discoverTests(root);
    const explicit = await Promise.all((args.testPaths ?? []).map(async (path: string) => {
      const file = await projectFile(root, path);
      if (!file.endsWith('.gd')) throw new Error(`Test entry must be a .gd file: ${path}`);
      return relative(root, file).split(sep).join('/');
    }));
    const stages: Record<string, unknown>[] = [];
    let extensionFailed = false;
    if (sources.extensions.length) {
      const marker = 'GODOT_MCP_EXTENSIONS=';
      const probe = await runCommand(godot, [
        '--headless', '--path', root, '--script', scriptPath('validate-extensions.gd'),
        '--', ...sources.extensions.map(path => 'res://' + path),
      ], { timeoutMs });
      const report = probe.stdout.split(/\r?\n/).find(line => line.startsWith(marker));
      let checks: unknown;
      if (report) checks = JSON.parse(report.slice(marker.length));
      const complete = Array.isArray(checks) && checks.length === sources.extensions.length &&
        checks.every(check => check && typeof check.loaded === 'boolean' && Number.isInteger(check.status));
      extensionFailed = complete && Array.isArray(checks) && checks.some(check => check.status === 1);
      const allLoaded = complete && Array.isArray(checks) && checks.every(check => check.loaded);
      stages.push({
        name: 'extensions',
        status: extensionFailed ? 'failed' : allLoaded && !probe.timedOut && probe.exitCode === 0 ? 'passed' : 'inconclusive',
        checks: complete ? checks : [], ...probe,
        diagnostics: [...diagnostics(probe.stdout), ...diagnostics(probe.stderr)],
      });
    } else {
      stages.push({ name: 'extensions', status: 'passed', files: [], detail: 'No GDExtension files discovered.' });
    }
    if (extensionFailed) {
      stages.push({ name: 'import', status: 'skipped', reason: 'GDExtension loading failed.' });
      stages.push({ name: 'scripts', status: 'skipped', reason: 'GDExtension loading failed.' });
      stages.push({ name: 'tests', status: 'skipped', reason: 'GDExtension loading failed.', candidates });
      return jsonResult({ status: 'failed', firstFailureStage: 'extensions', stages }, true);
    }
    const imported = await runCommand(godot, ['--headless', '--path', root, '--import'], { timeoutMs });
    const importDiagnostics = [...diagnostics(imported.stdout), ...diagnostics(imported.stderr)];
    const importFailed = imported.timedOut || imported.exitCode !== 0 || importDiagnostics.length > 0;
    stages.push({ name: 'import', status: importFailed ? 'failed' : 'passed', ...imported, diagnostics: importDiagnostics });
    if (importFailed) {
      stages.push({ name: 'scripts', status: 'skipped', reason: 'Project import failed.' });
      stages.push({ name: 'tests', status: 'skipped', reason: 'Project import failed.', candidates });
    } else {
      const checks = [];
      for (const path of sources.scripts) {
        const file = await projectFile(root, path);
        const result = await runCommand(godot, ['--headless', '--path', root, '--check-only', '--script', file], { timeoutMs });
        const errors = [...diagnostics(result.stdout), ...diagnostics(result.stderr)];
        checks.push({ path, ...result, diagnostics: errors, status: result.timedOut ? 'timed_out' : result.exitCode !== 0 || errors.length ? 'failed' : 'passed' });
      }
      const scriptsFailed = checks.some(check => check.status !== 'passed');
      stages.push({
        name: 'scripts',
        status: scriptsFailed ? 'failed' : checks.length ? 'passed' : 'inconclusive',
        checks,
        coverage: 'GDScript files outside .godot, .git, .gdignore directories and symlinks; other languages are not checked.',
      });
      if (scriptsFailed) {
        stages.push({ name: 'tests', status: 'skipped', reason: 'Script validation failed.', candidates });
      } else {
        const paths = [...new Set([...candidates.filter(candidate => candidate.runnable).map(candidate => candidate.path), ...explicit])].sort();
        const results = [];
        for (const path of paths) {
          results.push({ path, ...await runTestScript(godot, root, await projectFile(root, path), timeoutMs) });
        }
        const skipped = candidates.filter(candidate => !paths.includes(candidate.path));
        const status = results.some(result => result.status !== 'passed') ? 'failed' :
          !results.length || skipped.length ? 'inconclusive' : 'passed';
        stages.push({ name: 'tests', status, results, skipped });
      }
    }
    const failure = stages.find(stage => stage.status === 'failed');
    const status = failure ? 'failed' : stages.some(stage => stage.status !== 'passed') ? 'inconclusive' : 'passed';
    return jsonResult({ status, firstFailureStage: failure?.name ?? null, stages }, status !== 'passed');
  } catch (error) {
    return this.createErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

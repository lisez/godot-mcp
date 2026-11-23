import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { jsonResult, projectFile, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';

const valueTypes = [
  'bool', 'int', 'float', 'String', 'StringName', 'NodePath',
  'Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Vector4', 'Vector4i', 'Color',
  'Array', 'Dictionary',
] as const;
type ValueType = typeof valueTypes[number];

export const definition: Tool = {
  name: 'edit_resource',
  description: 'Preview or apply ordered, typed edits to one external .tres resource or explicitly selected embedded .tscn subresource.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      resourcePath: { type: 'string', description: 'Project-relative .tres or .tscn path.' },
      ownership: {
        type: 'string', enum: ['external_shared', 'embedded'],
        description: 'Declare external_shared for a .tres, or embedded for a .tscn subresource.',
      },
      allowSharedResource: {
        type: 'boolean',
        description: 'Must be true to explicitly authorize editing the shared external .tres resource.',
      },
      subresourceId: { type: 'string', description: 'Exact Godot embedded subresource ID from the .tscn.' },
      changes: {
        type: 'array',
        description: 'Ordered property changes. Each value is {type, value}; supported types are bool, int, float, String, StringName, NodePath, Vector2/2i, Vector3/3i, Vector4/4i, Color, Array and Dictionary.',
        items: {
          type: 'object', required: ['property', 'value'],
          properties: {
            property: { type: 'string' },
            value: {
              type: 'object', required: ['type', 'value'],
              properties: { type: { type: 'string', enum: valueTypes }, value: {} },
            },
          },
        },
      },
      mode: { type: 'string', enum: ['preview', 'apply'], description: 'Defaults to preview; only apply writes the resource file.' },
      expectedOriginalFingerprint: {
        type: 'string',
        description: 'Optional SHA-256 fingerprint returned by preview; on apply, reject if the target has changed since that preview.',
      },
    },
    required: ['projectPath', 'resourcePath', 'ownership', 'changes'],
  },
};

interface TypedValue {
  type: ValueType;
  value: unknown;
}

interface Change {
  property: string;
  value: TypedValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateJsonValue(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('Array and Dictionary values must be JSON-compatible and no more than 32 levels deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) validateJsonValue(item, depth + 1);
    return;
  }
  throw new Error('Array and Dictionary values must contain only finite JSON values.');
}

function validateTypedValue(input: unknown): TypedValue {
  if (!isRecord(input) || typeof input.type !== 'string' || !valueTypes.includes(input.type as ValueType) ||
      !Object.hasOwn(input, 'value')) {
    throw new Error(`Each change value must have a supported type and a value (${valueTypes.join(', ')}).`);
  }
  const type = input.type as ValueType;
  const value = input.value;
  if (type === 'bool' && typeof value !== 'boolean') throw new Error('bool values must be booleans.');
  if (type === 'int' && (!Number.isSafeInteger(value))) throw new Error('int values must be safe integers.');
  if (type === 'float' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('float values must be finite numbers.');
  if (['String', 'StringName', 'NodePath'].includes(type) && typeof value !== 'string') {
    throw new Error(`${type} values must be strings.`);
  }
  const lengths: Partial<Record<ValueType, number[]>> = {
    Vector2: [2], Vector2i: [2], Vector3: [3], Vector3i: [3],
    Vector4: [4], Vector4i: [4], Color: [3, 4],
  };
  if (lengths[type]) {
    if (!Array.isArray(value) || !lengths[type]!.includes(value.length) ||
        !value.every((part) => typeof part === 'number' && Number.isFinite(part))) {
      throw new Error(`${type} values must be arrays of ${lengths[type]!.join(' or ')} finite numbers.`);
    }
    if (type.endsWith('i') && !value.every(Number.isSafeInteger)) throw new Error(`${type} components must be safe integers.`);
  }
  if (type === 'Array' || type === 'Dictionary') {
    if ((type === 'Array') !== Array.isArray(value) || (type === 'Dictionary' && !isRecord(value))) {
      throw new Error(`${type} values must be JSON ${type === 'Array' ? 'arrays' : 'objects'}.`);
    }
    validateJsonValue(value);
  }
  return { type, value };
}

function validateChanges(input: unknown): Change[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Provide at least one property change.');
  const seen = new Set<string>();
  return input.map((item) => {
    if (!isRecord(item) || typeof item.property !== 'string' || !item.property.trim()) {
      throw new Error('Each change must name a nonempty property.');
    }
    if (seen.has(item.property)) throw new Error(`Property "${item.property}" appears more than once; combine it into one change.`);
    seen.add(item.property);
    return { property: item.property, value: validateTypedValue(item.value) };
  });
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function resourcePath(root: string, file: string): string {
  return 'res://' + relative(root, file).split(sep).join('/');
}

export async function handle(this: GodotServer, input: unknown): Promise<CallToolResult> {
  let stagedFile: string | undefined;
  let result: CallToolResult;
  try {
    if (!isRecord(input)) throw new Error('Expected resource-edit arguments.');
    const args = this.normalizeParameters(input) as Record<string, unknown>;
    const root = await requireProject(args.projectPath);
    const file = await projectFile(root, args.resourcePath);
    const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
    const mode = args.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'apply') throw new Error('mode must be preview or apply.');
    if (args.expectedOriginalFingerprint !== undefined) {
      if (mode !== 'apply') throw new Error('expectedOriginalFingerprint is only valid when mode is apply.');
      if (typeof args.expectedOriginalFingerprint !== 'string' || !/^[a-f\d]{64}$/i.test(args.expectedOriginalFingerprint)) {
        throw new Error('expectedOriginalFingerprint must be a 64-character SHA-256 hex string.');
      }
    }
    if (extension === '.tres') {
      if (args.ownership !== 'external_shared') throw new Error('A .tres target must declare ownership="external_shared".');
      if (args.allowSharedResource !== true) throw new Error('Editing a shared .tres requires allowSharedResource=true.');
      if (args.subresourceId !== undefined) throw new Error('subresourceId is only valid for an embedded .tscn resource.');
    } else if (extension === '.tscn') {
      if (args.ownership !== 'embedded' || typeof args.subresourceId !== 'string' ||
          !args.subresourceId.trim() || /[\/\\:\s]/.test(args.subresourceId)) {
        throw new Error('A .tscn target requires ownership="embedded" and an exact subresourceId.');
      }
      if (args.allowSharedResource !== undefined) throw new Error('allowSharedResource applies only to external .tres resources.');
    } else {
      throw new Error('resourcePath must refer to a .tres external resource or a .tscn containing an explicitly selected embedded subresource.');
    }
    const changes = validateChanges(args.changes);
    const original = await readFile(file);
    const fingerprint = sha256(original);
    if (typeof args.expectedOriginalFingerprint === 'string' &&
        args.expectedOriginalFingerprint.toLowerCase() !== fingerprint) {
      throw new Error('Resource fingerprint does not match expectedOriginalFingerprint; preview the current resource before applying.');
    }
    const stagedName = `.${file.slice(file.lastIndexOf(sep) + 1)}.godot-mcp-edit-${randomUUID()}${extension}`;
    stagedFile = file.slice(0, file.lastIndexOf(sep) + 1) + stagedName;
    const stageResourcePath = resourcePath(root, stagedFile);
    const sourceResourcePath = resourcePath(root, file);
    const engine = await requireGodot(this);
    const request = {
      ownership: args.ownership,
      sourcePath: sourceResourcePath,
      stagedPath: stageResourcePath,
      stagedFilePath: stagedFile,
      subresourceId: args.subresourceId,
      changes,
    };
    const run = await runCommand(engine, [
      '--headless', '--path', root, '--script', scriptPath('edit-resource.gd'), '--', JSON.stringify(request),
    ], { cwd: root, timeoutMs: 120_000 });
    const marker = 'GODOT_MCP_RESOURCE=';
    const reportLine = run.stdout.split(/\r?\n/).findLast((line) => line.startsWith(marker));
    const output = [run.stdout.replace(reportLine ?? '', ''), run.stderr].filter(Boolean).join('\n');
    if (run.timedOut) throw new Error('Resource edit validation timed out after 120 seconds.');
    if (!reportLine) throw new Error('Godot did not return a complete resource-edit report.\n' + output.trim());
    const report = JSON.parse(reportLine.slice(marker.length)) as Record<string, unknown>;
    if (run.exitCode !== 0 || /^\s*(?:SCRIPT ERROR|ERROR):/m.test(output) || report.error) {
      throw new Error(String(report.error || output.trim() || `Godot exited with code ${run.exitCode}.`));
    }
    if (report.validated !== true || !Array.isArray(report.changes) || report.changes.length !== changes.length) {
      throw new Error('Godot returned an incomplete resource-edit report.');
    }
    const currentFingerprint = sha256(await readFile(file));
    if (currentFingerprint !== fingerprint) throw new Error('Resource changed during editing; the staged edit was discarded.');
    if (mode === 'apply') {
      await rm(stagedFile + '.uid', { force: true });
      await rename(stagedFile, file);
      stagedFile = undefined;
    }
    result = jsonResult({
      status: mode === 'apply' ? 'applied' : 'previewed',
      resourcePath: args.resourcePath,
      ownership: args.ownership,
      ...(args.ownership === 'embedded' ? { subresourceId: args.subresourceId } : { sharedResource: true }),
      expectedOriginalFingerprint: fingerprint,
      changes: report.changes,
      warnings: [
        ...(args.ownership === 'external_shared' ? ['This external resource may be shared by other scenes or resources.'] : []),
        'Edits are offline: an open Godot editor may have unsaved changes, and this operation is not part of the editor Undo stack.',
        'Only the selected resource file is replaced; multi-file transactions and edits racing after the final fingerprint check are not protected.',
      ],
      diagnostics: output.trim(),
    });
  } catch (error) {
    result = jsonResult({ status: 'failed', message: error instanceof Error ? error.message : String(error) }, true);
  }
  const cleanupErrors: string[] = [];
  if (stagedFile) {
    for (const path of [stagedFile, stagedFile + '.uid']) {
      try {
        await rm(path, { force: true });
      } catch (error) {
        cleanupErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (cleanupErrors.length) {
    const operationResult = result.structuredContent;
    const message = isRecord(operationResult) && typeof operationResult.message === 'string'
      ? operationResult.message
      : 'Resource operation completed, but staged file cleanup failed.';
    return jsonResult({
      status: 'failed',
      message: `${message} Staged file cleanup failed.`,
      cleanupErrors,
      operationResult,
    }, true);
  }
  return result;
}

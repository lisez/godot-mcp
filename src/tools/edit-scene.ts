import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import {
  callGodotHelper,
  commitSceneStage,
  createSceneStagePath,
  normalizeSceneArguments,
  projectFingerprint,
  removeSceneStage,
  resolveScene,
  resolveSceneReference,
  sceneError,
  toolReport,
} from './scene-tool-utils.ts';
import { projectFile } from '../tool-runtime.ts';

const numbers = (length: number) => ({
  type: 'array',
  minItems: length,
  maxItems: length,
  items: { type: 'number' },
});
const taggedValue = (type: string, value: Record<string, unknown>) => ({
  type: 'object',
  properties: { type: { type: 'string', const: type }, value },
  required: ['type', 'value'],
  additionalProperties: false,
});
const vector2Value = taggedValue('Vector2', numbers(2));
const vector3Value = taggedValue('Vector3', numbers(3));
const vector4Value = taggedValue('Vector4', numbers(4));
const nodePathValue = taggedValue('NodePath', { type: 'string' });
const typedEditValue = {
  description: 'JSON primitives and containers, or tagged Godot values. Vectors, colors, planes, quaternions and vector-like transforms use fixed-length numeric arrays; rectangle, basis and 3D-transform values use typed components. Resource values identify an existing project resource by res:// path.',
  oneOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: {} },
    { type: 'object', not: { required: ['type'] }, additionalProperties: true },
    taggedValue('StringName', { type: 'string' }),
    nodePathValue,
    vector2Value,
    taggedValue('Vector2i', numbers(2)),
    vector3Value,
    taggedValue('Vector3i', numbers(3)),
    vector4Value,
    taggedValue('Vector4i', numbers(4)),
    taggedValue('Color', numbers(4)),
    taggedValue('Rect2', {
      type: 'object',
      properties: { position: vector2Value, size: vector2Value },
      required: ['position', 'size'],
      additionalProperties: false,
    }),
    taggedValue('Rect2i', {
      type: 'object',
      properties: { position: taggedValue('Vector2i', numbers(2)), size: taggedValue('Vector2i', numbers(2)) },
      required: ['position', 'size'],
      additionalProperties: false,
    }),
    taggedValue('Plane', numbers(4)),
    taggedValue('Quaternion', numbers(4)),
    taggedValue('AABB', {
      type: 'object',
      properties: { position: vector3Value, size: vector3Value },
      required: ['position', 'size'],
      additionalProperties: false,
    }),
    taggedValue('Basis', {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: vector3Value,
    }),
    taggedValue('Transform2D', {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: vector2Value,
    }),
    taggedValue('Transform3D', {
      type: 'object',
      properties: {
        basis: taggedValue('Basis', { type: 'array', minItems: 3, maxItems: 3, items: vector3Value }),
        origin: vector3Value,
      },
      required: ['basis', 'origin'],
      additionalProperties: false,
    }),
    taggedValue('Projection', {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: vector4Value,
    }),
    taggedValue('Array', { type: 'array', items: {} }),
    taggedValue('Dictionary', {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: {}, value: {} },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    }),
    {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Godot Resource class, or "Resource" for any resource class.' },
        path: { type: 'string', pattern: '^res://' },
      },
      required: ['type', 'path'],
      additionalProperties: false,
    },
  ],
};

export const definition: Tool = {
  name: 'edit_scene',
  description: 'Preview or apply an ordered, validated batch of offline edits to a Godot .tscn scene.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      scenePath: { type: 'string', description: 'Project-relative .tscn to edit.' },
      operations: {
        type: 'array',
        description: 'Ordered create_node, instantiate_scene, set_property, and connect_signal operations.',
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'create_node' },
                parentPath: { type: 'string', description: 'Root-relative parent path; use "." for the scene root.' },
                name: { type: 'string' },
                nodeType: { type: 'string', description: 'Instantiable built-in Godot Node class.' },
              },
              required: ['type', 'parentPath', 'name', 'nodeType'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'instantiate_scene' },
                parentPath: { type: 'string', description: 'Root-relative parent path; may refer to a node created earlier in this batch.' },
                name: { type: 'string' },
                scenePath: { type: 'string', description: 'Project-relative .tscn to instantiate.' },
              },
              required: ['type', 'parentPath', 'name', 'scenePath'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'set_property' },
                nodePath: { type: 'string', description: 'Root-relative target node path.' },
                property: { type: 'string' },
                value: typedEditValue,
              },
              required: ['type', 'nodePath', 'property', 'value'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'connect_signal' },
                sourcePath: { type: 'string', description: 'Root-relative signal source path.' },
                signal: { type: 'string' },
                targetPath: { type: 'string', description: 'Root-relative target node path.' },
                method: { type: 'string' },
                flags: { type: 'integer', minimum: 0, description: 'Godot ConnectFlags; must include CONNECT_PERSIST (2). Supported flags: CONNECT_DEFERRED (1), CONNECT_ONE_SHOT (4), CONNECT_REFERENCE_COUNTED (8).' },
                binds: { type: 'array', items: {} },
              },
              required: ['type', 'sourcePath', 'signal', 'targetPath', 'method'],
              additionalProperties: false,
            },
          ],
        },
      },
      mode: { type: 'string', enum: ['preview', 'apply'], default: 'preview' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647, default: 60000 },
      expectedOriginalFingerprint: {
        type: 'string',
        pattern: '^[a-f0-9]{64}$',
        description: 'Optional SHA-256 fingerprint returned by preview. On apply, reject if the current scene content no longer matches it.',
      },
    },
    required: ['projectPath', 'scenePath', 'operations'],
  },
};

function nodePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.split('/').some(part => part === '..')) {
    throw new Error(`${label} must be a non-empty root-relative node path without parent traversal.`);
  }
  return value;
}

async function normalizeOperations(root: string, value: unknown): Promise<Record<string, unknown>[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('operations must contain between 1 and 100 ordered operations.');
  }
  const result: Record<string, unknown>[] = [];
  async function validateResourceReferences(item: unknown): Promise<unknown> {
    if (Array.isArray(item)) return Promise.all(item.map(validateResourceReferences));
    if (!item || typeof item !== 'object') return item;
    const object = item as Record<string, unknown>;
    if (typeof object.type === 'string' && typeof object.path === 'string') {
      if (!object.path.startsWith('res://')) {
        throw new Error('Typed resource paths must use a project-relative res:// path.');
      }
      const filePath = object.path.split('::', 1)[0].slice('res://'.length);
      await projectFile(root, filePath);
    }
    const entries = await Promise.all(Object.entries(object).map(async ([key, child]) =>
      [key, await validateResourceReferences(child)] as const));
    return Object.fromEntries(entries);
  }
  for (let index = 0; index < value.length; index++) {
    const operation = value[index];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`Operation ${index} must be an object.`);
    }
    const item = operation as Record<string, any>;
    switch (item.type) {
      case 'create_node':
        nodePath(item.parentPath, `Operation ${index} parentPath`);
        if (typeof item.name !== 'string' || !item.name.trim() || /[/\\]/.test(item.name)) {
          throw new Error(`Operation ${index} name must be a non-empty node name without path separators.`);
        }
        if (typeof item.nodeType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.nodeType)) {
          throw new Error(`Operation ${index} nodeType must be a built-in Godot class name.`);
        }
        result.push({ type: item.type, parentPath: item.parentPath, name: item.name, nodeType: item.nodeType });
        break;
      case 'instantiate_scene':
        nodePath(item.parentPath, `Operation ${index} parentPath`);
        if (typeof item.name !== 'string' || !item.name.trim() || /[/\\]/.test(item.name)) {
          throw new Error(`Operation ${index} name must be a non-empty node name without path separators.`);
        }
        result.push({
          type: item.type,
          parentPath: item.parentPath,
          name: item.name,
          scenePath: await resolveSceneReference(root, item.scenePath, `Operation ${index} scenePath`),
        });
        break;
      case 'set_property':
        nodePath(item.nodePath, `Operation ${index} nodePath`);
        if (typeof item.property !== 'string' || !item.property.trim()) {
          throw new Error(`Operation ${index} property must be a non-empty property name.`);
        }
        if (item.value === undefined) throw new Error(`Operation ${index} must provide a value.`);
        result.push({
          type: item.type,
          nodePath: item.nodePath,
          property: item.property,
          value: await validateResourceReferences(item.value),
        });
        break;
      case 'connect_signal':
        nodePath(item.sourcePath, `Operation ${index} sourcePath`);
        nodePath(item.targetPath, `Operation ${index} targetPath`);
        if (typeof item.signal !== 'string' || !item.signal.trim() ||
            typeof item.method !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.method)) {
          throw new Error(`Operation ${index} must provide a signal name and valid target method.`);
        }
        if (item.flags !== undefined && (!Number.isSafeInteger(item.flags) || item.flags < 0)) {
          throw new Error(`Operation ${index} flags must be a non-negative integer.`);
        }
        if (item.binds !== undefined && !Array.isArray(item.binds)) {
          throw new Error(`Operation ${index} binds must be an array.`);
        }
        result.push({
          type: item.type,
          sourcePath: item.sourcePath,
          signal: item.signal,
          targetPath: item.targetPath,
          method: item.method,
          ...(item.flags === undefined ? {} : { flags: item.flags }),
          ...(item.binds === undefined ? {} : { binds: await validateResourceReferences(item.binds) }),
        });
        break;
      default:
        throw new Error(`Operation ${index} has unsupported type ${JSON.stringify(item.type)}.`);
    }
  }
  return result;
}

export async function handle(this: GodotServer, raw: unknown) {
  let stage: string | undefined;
  let response: CallToolResult;
  try {
    const args = normalizeSceneArguments(this, raw);
    const mode = args.mode ?? 'preview';
    if (mode !== 'preview' && mode !== 'apply') throw new Error('mode must be "preview" or "apply".');
    const suppliedFingerprint = args.expectedOriginalFingerprint;
    if (suppliedFingerprint !== undefined) {
      if (mode !== 'apply') throw new Error('expectedOriginalFingerprint is only valid when mode is "apply".');
      if (typeof suppliedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(suppliedFingerprint)) {
        throw new Error('expectedOriginalFingerprint must be a SHA-256 hexadecimal fingerprint returned by preview.');
      }
    }
    const { root, sceneFile, resourcePath, godot } = await resolveScene(this, args.projectPath, args.scenePath);
    const operations = await normalizeOperations(root, args.operations);
    const timeoutMs = args.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error('timeoutMs must be a positive 32-bit integer.');
    }
    const currentFingerprint = await projectFingerprint(sceneFile);
    if (suppliedFingerprint !== undefined && suppliedFingerprint !== currentFingerprint) {
      response = toolReport({
        scenePath: resourcePath,
        mode,
        expectedOriginalFingerprint: suppliedFingerprint,
        currentFingerprint,
        error: 'Scene changed since the supplied preview fingerprint; no edit was staged or applied.',
      }, true);
    } else {
      const expectedFingerprint = currentFingerprint;
      const stagePath = await createSceneStagePath(root, sceneFile);
      stage = stagePath.absolute;
      const result = await callGodotHelper(godot, root, 'edit-scene.gd', {
        scenePath: resourcePath,
        stagePath: 'res://' + stagePath.relative,
        operations,
      }, 'GODOT_MCP_EDIT_SCENE=', timeoutMs);
      if (!result.ok) {
        response = toolReport({
          scenePath: resourcePath,
          mode,
          expectedOriginalFingerprint: expectedFingerprint,
          error: result.error,
          diagnostics: result.diagnostics,
          stdout: result.stdout,
          stderr: result.stderr,
        }, true);
      } else {
        if (mode === 'apply') await commitSceneStage(stage, sceneFile, expectedFingerprint);
        response = toolReport({
          ...result.data,
          scenePath: resourcePath,
          mode,
          applied: mode === 'apply',
          expectedOriginalFingerprint: expectedFingerprint,
          warnings: [
            'Edits are offline and cannot participate in an open editor’s Undo stack.',
            'An open Godot editor may have unsaved changes that are not included.',
            'The final fingerprint check cannot protect edits made between that check and atomic replacement.',
            'Loading and instantiating scene nodes can run project script constructors; project-defined side effects are not rolled back.',
          ],
          diagnostics: result.diagnostics,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
    }
  } catch (error) {
    response = sceneError(this, error);
  }

  if (stage) {
    try {
      await removeSceneStage(stage);
    } catch (error) {
      const cleanupError = error instanceof Error ? error.message : String(error);
      if (response.structuredContent) {
        response = toolReport({
          ...response.structuredContent,
          operationSucceeded: !response.isError,
          cleanupError: `Could not remove temporary staged scene: ${cleanupError}`,
        }, true);
      } else {
        response = toolReport({
          operationSucceeded: false,
          operationOutcome: response.content,
          cleanupError: `Could not remove temporary staged scene: ${cleanupError}`,
        }, true);
      }
    }
  }
  return response;
}

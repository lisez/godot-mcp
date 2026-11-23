import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './edit-resource.ts';

const changes = [{ property: 'amount', value: { type: 'int', value: 7 } }];

async function fixture() {
  const project = join(process.cwd(), 'src/tools', `.edit-resource-test-${randomUUID()}`);
  await mkdir(project, { recursive: true });
  const engine = join(project, 'fake-godot');
  await writeFile(join(project, 'project.godot'), 'config_version=5\n');
  await writeFile(join(project, 'data.tres'), 'original resource bytes\n');
  await writeFile(join(project, 'scene.tscn'), '[gd_scene format=3]\n');
  await writeFile(engine, `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const request = JSON.parse(process.argv.at(-1));
appendFileSync(process.cwd() + '/fake-godot-calls', 'called\\n');
if (readFileSync(request.stagedFilePath.slice(0, request.stagedFilePath.lastIndexOf('/')) + '/project.godot', 'utf8').includes('helper-fails')) {
  console.log('GODOT_MCP_RESOURCE=' + JSON.stringify({ error: 'fixture serialization failure' }));
  process.exit(1);
}
if (readFileSync(request.stagedFilePath.slice(0, request.stagedFilePath.lastIndexOf('/')) + '/project.godot', 'utf8').includes('stage-is-directory')) {
  mkdirSync(request.stagedFilePath);
} else {
  writeFileSync(request.stagedFilePath, 'serialized replacement\\n');
}
if (readFileSync(request.stagedFilePath.slice(0, request.stagedFilePath.lastIndexOf('/')) + '/project.godot', 'utf8').includes('concurrent-change')) {
  appendFileSync(request.stagedFilePath.slice(0, request.stagedFilePath.lastIndexOf('/')) + '/data.tres', 'concurrent update\\n');
}
console.log('GODOT_MCP_RESOURCE=' + JSON.stringify({
  changes: request.changes.map(change => ({ property: change.property, before: { type: change.value.type, value: 1 }, after: change.value })),
  validated: true
}));
`, { mode: 0o755 });
  await chmod(engine, 0o755);
  const server = {
    godotPath: engine,
    normalizeParameters: (args: unknown) => args,
    createErrorResponse: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
  } as unknown as GodotServer;
  return { project, engine, server, close: () => rm(project, { recursive: true, force: true }) };
}

function request(project: string, extra: Record<string, unknown> = {}) {
  return {
    projectPath: project,
    resourcePath: 'data.tres',
    ownership: 'external_shared',
    allowSharedResource: true,
    changes,
    ...extra,
  };
}

test('edit_resource previews by default and requires explicit shared-resource ownership', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.project, 'data.tres'));
    const preview = await handle.call(f.server, request(f.project));
    assert.equal(preview.structuredContent?.status, 'previewed');
    assert.equal(preview.structuredContent?.ownership, 'external_shared');
    assert.deepEqual(preview.structuredContent?.changes, [{
      property: 'amount', before: { type: 'int', value: 1 }, after: { type: 'int', value: 7 },
    }]);
    assert.equal(await readFile(join(f.project, 'data.tres'), 'utf8'), before.toString());
    assert.deepEqual((await readdir(f.project)).filter(name => name.includes('godot-mcp-edit')), []);

    const denied = await handle.call(f.server, request(f.project, { allowSharedResource: false }));
    assert.ok(denied.isError);
    assert.match(String(denied.structuredContent?.message), /allowSharedResource=true/);
    const invalidOwnership = await handle.call(f.server, request(f.project, { ownership: 'embedded' }));
    assert.ok(invalidOwnership.isError);
    assert.equal(await readFile(join(f.project, 'data.tres'), 'utf8'), before.toString());
  } finally {
    await f.close();
  }
});

test('edit_resource applies a staged edit atomically after validation and returns its original fingerprint', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.project, 'data.tres'));
    const preview = await handle.call(f.server, request(f.project));
    const applied = await handle.call(f.server, request(f.project, {
      mode: 'apply', expectedOriginalFingerprint: preview.structuredContent?.expectedOriginalFingerprint,
    }));
    assert.equal(applied.structuredContent?.status, 'applied');
    assert.equal(applied.structuredContent?.expectedOriginalFingerprint, createHash('sha256').update(original).digest('hex'));
    assert.equal(await readFile(join(f.project, 'data.tres'), 'utf8'), 'serialized replacement\n');
    assert.deepEqual((await readdir(f.project)).filter(name => name.includes('godot-mcp-edit')), []);
  } finally {
    await f.close();
  }
});

test('edit_resource rejects a stale preview fingerprint before creating a staged file or running Godot', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const preview = await handle.call(f.server, request(f.project));
    const fingerprint = preview.structuredContent?.expectedOriginalFingerprint;
    assert.equal(typeof fingerprint, 'string');
    const callsBefore = (await readFile(join(f.project, 'fake-godot-calls'), 'utf8')).trim().split('\n').length;
    await writeFile(join(f.project, 'data.tres'), 'changed after preview\n');

    const stale = await handle.call(f.server, request(f.project, {
      mode: 'apply', expectedOriginalFingerprint: fingerprint,
    }));
    assert.ok(stale.isError);
    assert.match(String(stale.structuredContent?.message), /does not match expectedOriginalFingerprint/);
    assert.equal((await readFile(join(f.project, 'fake-godot-calls'), 'utf8')).trim().split('\n').length, callsBefore);
    assert.deepEqual((await readdir(f.project)).filter(name => name.includes('godot-mcp-edit')), []);
    assert.equal(await readFile(join(f.project, 'data.tres'), 'utf8'), 'changed after preview\n');
  } finally {
    await f.close();
  }
});

test('edit_resource reports staged cleanup failures instead of hiding them', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, 'project.godot'), 'stage-is-directory\n');
    const response = await handle.call(f.server, request(f.project));
    assert.ok(response.isError);
    assert.equal(response.structuredContent?.status, 'failed');
    assert.match(String(response.structuredContent?.message), /cleanup failed/);
    assert.match(JSON.stringify(response.structuredContent?.cleanupErrors), /godot-mcp-edit/);
    assert.equal((response.structuredContent?.operationResult as { status: string }).status, 'previewed');
  } finally {
    await f.close();
  }
});

test('edit_resource discards concurrent or failed staged writes and rejects unsupported typed values', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, 'project.godot'), 'concurrent-change\n');
    const concurrent = await handle.call(f.server, request(f.project, { mode: 'apply' }));
    assert.ok(concurrent.isError);
    assert.match(String(concurrent.structuredContent?.message), /changed during editing/);
    assert.equal(await readFile(join(f.project, 'data.tres'), 'utf8'), 'original resource bytes\nconcurrent update\n');

    await writeFile(join(f.project, 'project.godot'), 'helper-fails\n');
    const failed = await handle.call(f.server, request(f.project, { mode: 'apply' }));
    assert.ok(failed.isError);
    assert.match(String(failed.structuredContent?.message), /fixture serialization failure/);
    const invalid = await handle.call(f.server, request(f.project, {
      changes: [{ property: 'amount', value: { type: 'Vector3', value: [1, Infinity, 3] } }],
    }));
    assert.ok(invalid.isError);
    assert.match(String(invalid.structuredContent?.message), /finite numbers/);
    assert.deepEqual((await readdir(f.project)).filter(name => name.includes('godot-mcp-edit')), []);
  } finally {
    await f.close();
  }
});

test('edit_resource requires an explicit embedded subresource selector for scenes', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const invalid = await handle.call(f.server, {
      projectPath: f.project, resourcePath: 'scene.tscn', ownership: 'embedded', changes,
    });
    assert.ok(invalid.isError);
    assert.match(String(invalid.structuredContent?.message), /exact subresourceId/);
    const preview = await handle.call(f.server, {
      projectPath: f.project,
      resourcePath: 'scene.tscn',
      ownership: 'embedded',
      subresourceId: 'Gradient_1',
      changes,
    });
    assert.equal(preview.structuredContent?.status, 'previewed');
    assert.equal(preview.structuredContent?.ownership, 'embedded');
    assert.equal(preview.structuredContent?.subresourceId, 'Gradient_1');
    assert.equal(await readFile(join(f.project, 'scene.tscn'), 'utf8'), '[gd_scene format=3]\n');
  } finally {
    await f.close();
  }
});

test('edit_resource edits real external and embedded resources with Godot', {
  skip: !process.env.GODOT_TEST_BIN && 'Set GODOT_TEST_BIN to run the Godot integration test.',
}, async () => {
  const f = await fixture();
  const server = { ...f.server, godotPath: process.env.GODOT_TEST_BIN } as GodotServer;
  try {
    await writeFile(join(f.project, 'resource.gd'), 'extends Resource\n@export var amount: int = 1\n');
    await writeFile(join(f.project, 'holder.gd'), 'extends Node\n@export var item: Resource\n');
    const external = '[gd_resource type="Resource" load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://resource.gd" id="1_script"]\n\n[resource]\nscript = ExtResource("1_script")\namount = 1\n';
    await writeFile(join(f.project, 'data.tres'), external);
    const embedded = '[gd_scene load_steps=4 format=3]\n\n[ext_resource type="Script" path="res://holder.gd" id="1_holder"]\n[ext_resource type="Script" path="res://resource.gd" id="2_resource"]\n\n[sub_resource type="Resource" id="Resource_editable"]\nscript = ExtResource("2_resource")\namount = 3\n\n[node name="Root" type="Node"]\nscript = ExtResource("1_holder")\nitem = SubResource("Resource_editable")\n';
    await writeFile(join(f.project, 'scene.tscn'), embedded);

    const preview = await handle.call(server, request(f.project));
    assert.equal(preview.structuredContent?.status, 'previewed', String(preview.structuredContent?.message));
    assert.equal(await readFile(join(f.project, 'data.tres'), 'utf8'), external);
    const applied = await handle.call(server, request(f.project, {
      mode: 'apply', expectedOriginalFingerprint: preview.structuredContent?.expectedOriginalFingerprint,
    }));
    assert.equal(applied.structuredContent?.status, 'applied', String(applied.structuredContent?.message));
    assert.match(await readFile(join(f.project, 'data.tres'), 'utf8'), /amount = 7/);

    const embeddedRequest = {
      projectPath: f.project, resourcePath: 'scene.tscn', ownership: 'embedded',
      subresourceId: 'Resource_editable',
      changes: [{ property: 'amount', value: { type: 'int', value: 8 } }],
    };
    const embeddedPreview = await handle.call(server, embeddedRequest);
    assert.equal(embeddedPreview.structuredContent?.status, 'previewed', String(embeddedPreview.structuredContent?.message));
    assert.equal(await readFile(join(f.project, 'scene.tscn'), 'utf8'), embedded);
    const embeddedApplied = await handle.call(server, {
      ...embeddedRequest, mode: 'apply',
      expectedOriginalFingerprint: embeddedPreview.structuredContent?.expectedOriginalFingerprint,
    });
    assert.equal(embeddedApplied.structuredContent?.status, 'applied', String(embeddedApplied.structuredContent?.message));
    assert.match(await readFile(join(f.project, 'scene.tscn'), 'utf8'), /amount = 8/);
  } finally {
    await f.close();
  }
});

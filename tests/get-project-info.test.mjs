import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(process.cwd(), 'build', 'index.js');

async function withServer(callback) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      GODOT_PATH: process.execPath,
    },
    stderr: 'ignore',
  });
  const client = new Client(
    { name: 'get-project-info-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

async function getProjectInfo(projectPath) {
  return withServer(async (client) => {
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { projectPath },
    });
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, 'text');
    return JSON.parse(result.content[0].text);
  });
}

test('get_project_info uses config/name instead of the directory basename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-mcp-project-info-'));
  try {
    const projectPath = join(root, 'project-folder');
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, 'project.godot'),
      '[application]\nconfig/name="Configured Project"\n',
      'utf8'
    );

    const info = await getProjectInfo(projectPath);
    assert.equal(info.name, 'Configured Project');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('get_project_info falls back to the directory basename without config/name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-mcp-project-info-'));
  try {
    const projectPath = join(root, 'project-without-name');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'project.godot'), '[application]\n', 'utf8');

    const info = await getProjectInfo(projectPath);
    assert.equal(info.name, basename(projectPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

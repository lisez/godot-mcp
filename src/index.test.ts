import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(process.cwd(), 'src', 'index.ts');

async function withServer<T>(
  callback: (client: Client) => Promise<T>,
  godotPath = process.execPath,
  entryPath = serverPath
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    env: {
      ...process.env,
      GODOT_PATH: godotPath,
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

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  assert.ok(Array.isArray(result.content));
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  assert.equal(typeof content.text, 'string');
  return content.text;
}

async function getProjectInfo(projectPath: string) {
  return withServer(async (client) => {
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { projectPath },
    });
    assert.notEqual(result.isError, true);
    return JSON.parse(firstText(result));
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

test('all tools are registered and routed to their handlers', async () => {
  const toolNames = [
    'launch_editor', 'run_project', 'get_debug_output', 'stop_project',
    'get_godot_version', 'list_projects', 'get_project_info', 'create_scene',
    'add_node', 'load_sprite', 'export_mesh_library', 'save_scene', 'get_uid',
    'update_project_uids', 'initialize_project',
  ];

  await withServer(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), toolNames);
    for (const name of toolNames) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError === true, name !== 'get_godot_version', name);
      firstText(result);
    }
    await assert.rejects(
      client.callTool({ name: 'unknown_tool', arguments: {} }),
      /Unknown tool: unknown_tool/
    );
  });
});

test('resources expose Godot documentation references', async () => {
  await withServer(async (client) => {
    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri),
      [
        'godot://init-project',
        'godot://references',
        'godot://references/gdscript',
        'godot://references/c-sharp',
        'godot://references/cpp',
        'godot://references/other-languages',
        'godot://references/tscn',
        'godot://references/classes',
      ]
    );

    const reference = await client.readResource({ uri: 'godot://references/gdscript' });
    const content = reference.contents[0];
    assert.ok(content && 'text' in content);
    assert.equal(content.text, 'https://docs.godotengine.org/en/latest/tutorials/scripting/gdscript/');
  });
});

test('initialize_project creates project.godot without overwriting existing content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-mcp-init-project-'));
  try {
    const projectPath = join(root, 'new-project');
    await mkdir(projectPath);

    await withServer(async (client) => {
      const result = await client.callTool({
        name: 'initialize_project',
        arguments: { projectPath },
      });
      assert.notEqual(result.isError, true);
      assert.equal(await readFile(join(projectPath, 'project.godot'), 'utf8'), '');

      await writeFile(join(projectPath, 'project.godot'), '[application]\n', 'utf8');
      const existing = await client.callTool({
        name: 'initialize_project',
        arguments: { projectPath },
      });
      assert.notEqual(existing.isError, true);
      assert.equal(await readFile(join(projectPath, 'project.godot'), 'utf8'), '[application]\n');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool modules share process state and use the bundled operations script', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-mcp-tools-'));
  const packageRoot = await mkdtemp(join(process.cwd(), 'node_modules', 'godot-mcp-test-'));
  try {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    await cp('package.json', join(packageRoot, 'package.json'));
    await cp('dist', join(packageRoot, 'dist'), { recursive: true });
    const packagedServerPath = join(packageRoot, manifest.bin['godot-mcp']);
    const godotPath = join(root, 'godot.mjs');
    await writeFile(godotPath, `#!${process.execPath}
import { existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('4.4.stable');
} else if (args.includes('--script')) {
  if (!existsSync(args[args.indexOf('--script') + 1])) process.exit(1);
  console.log(JSON.stringify(args));
} else {
  setTimeout(() => {}, 5000);
}
`, { mode: 0o755 });
    await writeFile(join(root, 'project.godot'), '[application]\n', 'utf8');

    await withServer(async (client) => {
      const created = await client.callTool({
        name: 'create_scene',
        arguments: { project_path: root, scene_path: 'test.tscn' },
      });
      assert.notEqual(created.isError, true);
      const args = JSON.parse(firstText(created).split('\n\nOutput: ')[1]);
      assert.equal(args[args.indexOf('--script') + 1], join(packageRoot, 'dist', 'scripts', 'godot-operations.gd'));
      assert.equal(args[args.indexOf('--script') + 2], 'create_scene');
      assert.deepEqual(JSON.parse(args[args.indexOf('--script') + 3]), {
        scene_path: 'test.tscn',
        root_node_type: 'Node2D',
      });

      const started = await client.callTool({ name: 'run_project', arguments: { projectPath: root } });
      assert.notEqual(started.isError, true);
      const output = await client.callTool({ name: 'get_debug_output', arguments: {} });
      assert.notEqual(output.isError, true);
      const stopped = await client.callTool({ name: 'stop_project', arguments: {} });
      assert.notEqual(stopped.isError, true);
      assert.equal(JSON.parse(firstText(stopped)).message, 'Godot project stopped');
      const afterStop = await client.callTool({ name: 'get_debug_output', arguments: {} });
      assert.equal(afterStop.isError, true);
    }, godotPath, packagedServerPath);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

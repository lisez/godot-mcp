# Godot MCP

[![MCP Server](https://badge.mcpx.dev?type=server)](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[![Last commit](https://img.shields.io/github/last-commit/lisez/godot-mcp)](https://github.com/lisez/godot-mcp/commits/main)
[![Stars](https://img.shields.io/github/stars/lisez/godot-mcp)](https://github.com/lisez/godot-mcp/stargazers)
[![Forks](https://img.shields.io/github/forks/lisez/godot-mcp)](https://github.com/lisez/godot-mcp/network/members)
[![License](https://img.shields.io/badge/License-MIT-red.svg)](LICENSE)

Godot MCP is a [Model Context Protocol](https://modelcontextprotocol.io/introduction) server that lets AI assistants inspect and operate Godot projects through the Godot editor and command-line tools.

> This repository is forked from [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp).

## Features

- Launch the Godot editor and run or stop projects.
- Read project debug output and detect the installed Godot version.
- Find Godot projects and inspect their structure.
- Create and edit scenes, add nodes, load sprites, save scenes, and export 3D scenes as `MeshLibrary` resources.
- Read and update resource UIDs (UID operations require Godot 4.4 or later).

## Requirements

- [Godot Engine](https://godotengine.org/download) installed on your system.
- Node.js 26 or later and npm.
- An MCP-compatible client.

## Set up

Run the server with `npx`; no repository clone or global install is needed. The first run downloads the package directly from GitHub:

### Claude Code

```bash
claude mcp add godot -- npx -y github:lisez/godot-mcp
```

### Other MCP clients

Add this server configuration to your MCP client's settings:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "github:lisez/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot"
      }
    }
  }
}
```

`GODOT_PATH` is optional when Godot can be found automatically. Configure it if Godot is installed in a non-standard location. Use your client's MCP configuration location and format; for example, Cursor supports project-specific settings in `.cursor/mcp.json`.

## Available tools

| Tool | Purpose |
|------|---------|
| `launch_editor` | Open a Godot project in the editor |
| `run_project` | Run a Godot project |
| `stop_project` | Stop a running project |
| `get_debug_output` | Read output from a running project |
| `get_godot_version` | Get the installed Godot version |
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Inspect a project's structure |
| `create_scene` | Create a scene |
| `add_node` | Add a node to a scene |
| `load_sprite` | Load a sprite or texture into a `Sprite2D` node |
| `save_scene` | Save a scene, optionally as a variant |
| `export_mesh_library` | Export a 3D scene as a `MeshLibrary` |
| `get_uid` | Get a file's Godot UID |
| `update_project_uids` | Update UIDs in a project |

## Configuration

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable. Set this when Godot is not found automatically. |
| `DEBUG` | Set to `true` to enable detailed server-side logging. |

## Development

To run from a local checkout, clone the repository and install its dependencies:

```bash
git clone https://github.com/lisez/godot-mcp.git
cd godot-mcp
npm ci
```

The server runs compiled JavaScript. `npm ci` builds it automatically; after making changes, run `npm run build` to rebuild it. From the repository root, run:

```bash
npm test
npm run typecheck
```

The project is implemented in TypeScript under `src/`. Complex scene and resource operations are handled by `src/scripts/godot-operations.gd`.

## Troubleshooting

- **Godot is not found:** Set `GODOT_PATH` to the Godot executable and restart your MCP client.
- **A project cannot be opened:** Check that the supplied path points to a Godot project directory containing `project.godot`.
- **MCP tools are unavailable:** Confirm the server configuration runs `npx -y github:lisez/godot-mcp`, Node.js 26 or later is available, and restart or refresh the client.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

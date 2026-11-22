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
| `initialize_project` | Create a directory with a `project.godot` file |
| `inspect_model_3d` | Inspect imported transforms and measure between two 3D node origins |
| `run_tests` | Run a native Godot test script headlessly and report failing source lines |
| `replay_input` | Replay multi-finger touch events and capture positions or screenshots by physics frame |
| `export_project` | Build an export preset and verify its artifact and APK signature |
| `test_android_foldable` | Observe an installed APK through a sequence of emulator posture changes |

### Inspect a model and run tests

Call `inspect_model_3d` with a Godot 4 project and a project-relative `.glb` or `.tscn`. Model inspection and scene replay first run the Godot editor’s headless import step so a fresh checkout can load its resources. Omit the two endpoints to discover their paths. Every node has a path and parent, and each 3D node has its local and model-root transforms. For example, measure from the model root to a child node. Replace the paths with paths from your project.

```json
{
  "projectPath": "/path/to/project",
  "modelPath": "assets/model.glb",
  "fromNode": ".",
  "toNode": "Marker"
}
```

The returned displacement, distance and unit direction are in model-root coordinates. Coincident origins yield a distance of zero and a null direction.

Call `run_tests` with a test script from your project.

```json
{
  "projectPath": "/path/to/project",
  "scriptPath": "tests/test.gd",
  "timeoutMs": 60000
}
```

Supply a native GDScript entry point runnable with Godot's `--script`, such as a script extending `SceneTree` that calls `quit()` when finished. Import the project's dependencies first. Results include `passed`, `failed` or `timed_out`, the exit code, duration, output and diagnostics with source locations when available. A reported Godot assertion fails the run even on exit code zero. The default deadline is 60 seconds.

### Replay touch input

For `replay_input`, supply a scene, a seed for Godot's global random number generator, and the input and capture schedules. Frame zero is the first scheduled physics tick. Coordinates are in viewport pixels. Events within a frame are delivered in list order, and each drag or release refers to a previously pressed finger.

```json
{
  "projectPath": "/path/to/project",
  "scenePath": "main.tscn",
  "seed": 42,
  "events": [
    {"frame": 0, "fingerId": 0, "type": "press", "x": 40, "y": 180},
    {"frame": 1, "fingerId": 0, "type": "drag", "x": 70, "y": 180},
    {"frame": 1, "fingerId": 1, "type": "press", "x": 270, "y": 180},
    {"frame": 2, "fingerId": 1, "type": "release", "x": 270, "y": 180},
    {"frame": 3, "fingerId": 0, "type": "release", "x": 70, "y": 180}
  ],
  "captures": [{"frame": 2, "nodePaths": ["Player"], "screenshot": true}]
}
```

Node paths are relative to the scene root. Captures report global 2D or 3D positions after the physics update. Screenshots require a working display and renderer and arrive as MCP PNG image content, indexed from the capture record. Position-only runs work headlessly.

### Export and exercise a foldable APK

Call `export_project` with the exact preset name from `export_presets.cfg`, a `debug` or `release` mode and an absolute or project-relative output filename.

```json
{"projectPath":"/path/to/project","preset":"Android","mode":"debug","outputPath":"build/game.apk"}
```

Install the engine's matching export templates or configure the preset's custom templates. For Android, configure the JDK and Android SDK in Godot and make Android SDK Build Tools available for signature verification. The report includes build checks and the published artifact path on success. A failed build or signature check preserves the previous artifact.

With a running foldable Android emulator, call `test_android_foldable`.

```json
{"apkPath":"/path/to/project/build/game.apk","emulatorSerial":"emulator-5554","states":["folded","unfolded"]}
```

The host needs `adb` and `aapt` from Android SDK Platform Tools and Build Tools. Set `ANDROID_HOME` to the SDK or put the executables on `PATH`. Use an emulator supporting the fold and unfold commands and device-state reporting. The tool installs the APK, launches its Activity once, and waits for a stable posture and focused app window at each step. Each step includes a PNG, window bounds, observed lifecycle events and app logs. Hinge geometry includes its coordinate space and source when available, or a reason it could not be observed. An application can log state identifiers for its own continuity checks.

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

Set `GODOT_TEST_BIN` to a Godot 4 editor executable to include native engine integration tests. Set `GODOT_REPLAY_SCREENSHOT_TEST=1` on a host with a working display to exercise PNG capture as well.

The project is implemented in TypeScript under `src/`. Complex scene and resource operations are handled by `src/scripts/godot-operations.gd`.

## Troubleshooting

- **Godot is not found:** Set `GODOT_PATH` to the Godot executable and restart your MCP client.
- **A project cannot be opened:** Check that the supplied path points to a Godot project directory containing `project.godot`.
- **MCP tools are unavailable:** Confirm the server configuration runs `npx -y github:lisez/godot-mcp`, Node.js 26 or later is available, and restart or refresh the client.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

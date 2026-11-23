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
| `validate_project` | Check project import and GDScript parsing, and run discovered standalone test scripts |
| `edit_resource` | Preview or apply typed property changes to one external or embedded resource |
| `inspect_scene` | Inspect a scene's serialized nodes, properties, connections and resource references |
| `edit_scene` | Preview or apply a batch of offline scene edits |
| `preview_scene` | Run a scene and capture a specified viewport frame |
| `check_export_readiness` | Check export prerequisites without building an artifact |
| `replay_input` | Replay touch, keyboard, mouse and gamepad events with frame captures and assertions |
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

`validate_project` runs project import and GDScript checks before executing discovered tests. Candidates are files whose names contain `.test.` or are under a `test` or `tests` directory. Only `.gd` files with a recognizable direct `extends SceneTree` or `extends MainLoop` declaration are run automatically; other candidates are reported as skipped. `.godot`, `.git`, directories containing `.gdignore`, symlinks, and Godot `.uid` and `.import` metadata are excluded. Pass `testPaths` to include additional project-relative GDScript entry points. Tests run project code and can have side effects. An incomplete test selection, absent tests, or an unverified extension yields an inconclusive result rather than a pass.

```json
{"projectPath":"/path/to/project","testPaths":["tools/run_checks.gd"],"timeoutMs":60000}
```

### Edit a resource

`edit_resource` defaults to preview and returns typed before/after values and a fingerprint. Supply `mode: "apply"` to write the change, and optionally pass the preview's `expectedOriginalFingerprint` to reject a stale preview. External `.tres` resources require `ownership: "external_shared"` and `allowSharedResource: true`; changes may affect every scene using that resource. Embedded resources require a `.tscn` and `ownership: "embedded"` with its exact `subresourceId`.

```json
{"projectPath":"/path/to/project","resourcePath":"materials/ground.tres","ownership":"external_shared","allowSharedResource":true,"changes":[{"property":"roughness","value":{"type":"float","value":0.5}}]}
```

Edits are offline and cannot use the editor's undo stack. An open editor may have unsaved changes; multi-file edits and writes racing after the final fingerprint check are not protected.

### Inspect, edit and preview a scene

`inspect_scene` reports the file-local serialized scene, not dynamically created runtime nodes or every default property. Use its paths with `edit_scene`, which previews by default:

```json
{"projectPath":"/path/to/project","scenePath":"menu.tscn","operations":[{"type":"set_property","nodePath":"Menu","property":"position","value":{"type":"Vector2","value":[20,30]}}]}
```

Set `mode` to `apply` to save a validated batch. Supply the returned `expectedOriginalFingerprint` when applying to reject a stale preview. Edits are offline, not part of editor Undo, and cannot protect changes made after the final fingerprint check.

Use `preview_scene` to run a fresh process and capture the requested frame:

```json
{"projectPath":"/path/to/project","scenePath":"menu.tscn","width":1280,"height":720,"captureFrame":1}
```

Repeat with a narrow width and height to inspect another layout. `captureFrame` is zero-based: frame 0 is the first process/physics update after the scene is installed. Preview requires a graphical renderer and executes project code, including autoloads; project initialization can have side effects.

### Replay input

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

Node paths are relative to the scene root. Captures report global 2D or 3D positions after the physics update. Screenshots require a working display and renderer and arrive as MCP PNG image content, indexed from the capture record. During screenshot rendering, node processing is temporarily paused to preserve frame order; timers or direct signal callbacks may still affect the scene. Position-only runs work headlessly.

Replay also accepts `key`, `mouse_button`, `mouse_motion`, `joypad_button`, and `joypad_axis` events. For example, add `{"frame":0,"type":"key","keycode":65,"pressed":true}` and its release in a later frame. These are synthetic Godot input events, not hardware devices. Optional `assertions` are evaluated after physics:

```json
{"frame":2,"nodePath":"Player","property":"position","operator":"approximately","expected":[10,20],"tolerance":0.1}
```

Assertions report their frame, expected and actual values; a mismatch sets `status` to `failed` and the MCP result to an error. Supported comparisons include equality, inequality, numeric ordering, and approximate numeric or vector equality. A fixed seed does not guarantee deterministic project behavior.

### Export and exercise a foldable APK

Call `export_project` with the exact preset name from `export_presets.cfg`, a `debug` or `release` mode and an absolute or project-relative output filename.

```json
{"projectPath":"/path/to/project","preset":"Android","mode":"debug","outputPath":"build/game.apk"}
```

Install the engine's matching export templates or configure the preset's custom templates. For Android, configure the JDK and Android SDK in Godot and make Android SDK Build Tools available for signature verification. The report includes build checks and the published artifact path on success. A failed build or signature check preserves the previous artifact.

Before building, call `check_export_readiness` with the project, exact preset and `debug` or `release` mode. It reports known missing prerequisites and separately marks checks that cannot establish compatibility as unknown; it does not build or publish an artifact.

```json
{"projectPath":"/path/to/project","preset":"Android","mode":"debug"}
```

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

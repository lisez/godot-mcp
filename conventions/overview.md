# Repository Overview

## Project structure

- `src/index.ts` starts the MCP server and registers tools.
- `src/tools/` contains individual MCP tool implementations.
- `src/process.ts` provides process helpers.
- `src/scripts/` contains GDScript helpers used by the TypeScript server.
- Tests belong next to the code they cover, rather than in a separate test directory.

## Naming conventions

- Use kebab-lowercase names for files and directories whenever there is no framework, ecosystem, or tool requirement otherwise.
  - Preferred: `get-project-info.ts`, `get-project-info.test.ts`
  - Avoid: `getProjectInfo.ts`, `GetProjectInfo.ts`, `get_project_info.ts`
- Preserve required names such as `AGENTS.md`, `README.md`, `package.json`, and `tsconfig.json`.
- Package, tool, and configuration identifiers may use the repository or ecosystem's established naming style.

## Test placement

- Keep test files side-by-side with the source or module they test.
- Match the implementation filename and add a test suffix, for example:
  - `src/tools/get-project-info.ts`
  - `src/tools/get-project-info.test.ts`
- If a test covers server-wide behavior, place it beside the entry point it exercises, such as `src/index.test.ts`, rather than under a centralized test directory.
- Do not create or add new tests to `tests/` unless the existing test runner or project tooling requires it.

## Development

- Use TypeScript for server and tool code.
- Use Node.js built-in test tooling for tests.
- Run `npm test` and `npm run typecheck` before completing changes.
- Keep documentation in Markdown and keep behavior examples accurate.

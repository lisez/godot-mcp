import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface TestCandidate {
  path: string;
  runnable: boolean;
  reason?: string;
}

export async function discoverTests(root: string): Promise<TestCandidate[]> {
  const candidates: TestCandidate[] = [];
  async function visit(directory: string, inTestDirectory: boolean): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (directory !== root && entries.some(entry => entry.name === '.gdignore')) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === '.godot' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, inTestDirectory || entry.name === 'test' || entry.name === 'tests');
      } else if (entry.isFile() && !entry.name.endsWith('.uid') && !entry.name.endsWith('.import') &&
          (inTestDirectory || entry.name.includes('.test.'))) {
        const name = relative(root, path).split(sep).join('/');
        if (!entry.name.endsWith('.gd')) {
          candidates.push({ path: name, runnable: false, reason: 'Not a GDScript entry point.' });
          continue;
        }
        const source = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
        const declaration = source.split(/\r?\n/).find(line => {
          const trimmed = line.trim();
          return trimmed && !trimmed.startsWith('#') &&
            !/^@tool\s*(?:#.*)?$/.test(trimmed) &&
            !/^class_name\s+[A-Za-z_]\w*\s*(?:#.*)?$/.test(trimmed);
        });
        const runnable = declaration !== undefined && /^extends\s+(?:SceneTree|MainLoop)\s*(?:#.*)?$/.test(declaration);
        candidates.push({ path: name, runnable, ...(!runnable && { reason: 'No direct SceneTree or MainLoop declaration.' }) });
      }
    }
  }
  await visit(root, false);
  return candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

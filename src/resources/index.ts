import type { Resource } from '@modelcontextprotocol/sdk/types.js';

export const resources: Resource[] = [
  {
    uri: 'godot://init-project',
    name: 'Initialize a Godot project',
    description: 'Use the initialize_project tool to create project.godot in an existing target folder.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references',
    name: 'Godot documentation',
    description: 'Main documentation for the Godot Engine.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references/gdscript',
    name: 'GDScript reference',
    description: 'Godot documentation for GDScript.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references/c-sharp',
    name: 'C# and .NET reference',
    description: 'Godot documentation for C# and .NET.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references/cpp',
    name: 'C++ (godot-cpp) reference',
    description: 'Godot documentation for C++ with godot-cpp.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references/other-languages',
    name: 'Other languages reference',
    description: 'Godot documentation for other scripting languages.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references/tscn',
    name: 'TSCN file format reference',
    description: 'Godot documentation for the TSCN file format.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'godot://references/classes',
    name: 'Godot classes index',
    description: 'Index of Godot Engine classes.',
    mimeType: 'text/markdown',
  },
];

const resourceContents: Record<string, string> = {
  'godot://init-project':
    'Initialize a Godot project in an existing target folder by calling the initialize_project tool with that folder path. The tool creates an empty project.godot without overwriting an existing file.',
  'godot://references': 'https://docs.godotengine.org/',
  'godot://references/gdscript':
    'https://docs.godotengine.org/en/latest/tutorials/scripting/gdscript/',
  'godot://references/c-sharp':
    'https://docs.godotengine.org/en/latest/tutorials/scripting/c_sharp/',
  'godot://references/cpp':
    'https://docs.godotengine.org/en/latest/tutorials/scripting/cpp/',
  'godot://references/other-languages':
    'https://docs.godotengine.org/en/latest/tutorials/scripting/other_languages.html',
  'godot://references/tscn':
    'https://docs.godotengine.org/en/latest/engine_details/file_formats/tscn.html',
  'godot://references/classes':
    'https://docs.godotengine.org/en/latest/classes/index.html',
};

export function readResource(uri: string) {
  const text = resourceContents[uri];
  if (text === undefined) {
    return undefined;
  }

  return {
    contents: [{ uri, mimeType: 'text/markdown', text }],
  };
}

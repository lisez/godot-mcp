import { existsSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GodotServer } from '../index.ts';
import { jsonResult, requireGodot, requireProject, runCommand, scriptPath } from '../tool-runtime.ts';

export const definition: Tool = {
  name: 'check_export_readiness',
  description: 'Safely inspect export prerequisites without building or publishing an artifact.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Project directory containing project.godot.' },
      preset: { type: 'string', description: 'Exact name from export_presets.cfg.' },
      mode: { type: 'string', enum: ['debug', 'release'] },
    },
    required: ['projectPath', 'preset', 'mode'],
  },
};

type CheckStatus = 'passed' | 'missing' | 'unsupported' | 'unknown';
type Check = {
  name: string;
  status: CheckStatus;
  evidence: string[];
  remediation?: string;
};
type PresetReport = {
  preset_found: boolean;
  platform?: string;
  host_os?: string;
  custom_features?: string;
  options?: Record<string, unknown>;
  extensions?: { path: string; libraries: Record<string, unknown>; dependencies: Record<string, unknown>; readable?: boolean; autodetect?: string }[];
  scan_incomplete?: string[];
  scan_ignored?: string[];
  standard_template?: { path: string; exists: boolean };
  error?: string;
};

function check(name: string, status: CheckStatus, evidence: string[], remediation?: string): Check {
  return { name, status, evidence, ...(remediation ? { remediation } : {}) };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function directoryState(path: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    return (await stat(path)).isDirectory() ? 'present' : 'missing';
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unknown';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function redactOutput(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/^.*(?:password|passwd|token|secret|credential).*$/gim, '[sensitive setting omitted]')
    .trim()
    .slice(0, 4000);
}

async function editorSetting(project: string, key: string): Promise<string | undefined> {
  const appData = process.env.APPDATA;
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const configDirs = new Set([
    ...(xdgConfig ? [join(xdgConfig, 'godot')] : []),
    join(homedir(), '.config', 'godot'),
    join(homedir(), 'Library', 'Application Support', 'Godot'),
    ...(appData ? [join(appData, 'Godot')] : []),
  ]);
  for (const dir of configDirs) {
    const file = join(dir, 'editor_settings-4.tres');
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = contents.match(new RegExp(`^\\s*(?:"${escapedKey}"|${escapedKey})\\s*(?::|=)\\s*"((?:\\\\.|[^"])*)"\\s*,?\\s*$`, 'm'));
    if (!match) continue;
    const value = match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    if (!value) return undefined;
    const candidate = isAbsolute(value) ? value : resolve(project, value);
    if (existsSync(candidate)) return candidate;
    return value;
  }
  return undefined;
}

function displayPath(project: string, path: string): string {
  const relativePath = relative(project, path);
  return relativePath && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath)
    ? relativePath
    : path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function fileState(path: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    return (await stat(path)).isFile() ? 'present' : 'missing';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

function templateCandidates(version: string): string[] {
  const dirs = new Set<string>();
  const parsedVersion = /^(4\.\d+(?:\.\d+)?\.(?:stable|rc\d+|beta\d+|dev\d+|alpha\d+))/i.exec(version)?.[1] ?? version;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) dirs.add(join(xdg, 'godot', 'export_templates', parsedVersion));
  dirs.add(join(homedir(), '.local', 'share', 'godot', 'export_templates', parsedVersion));
  if (process.env.APPDATA) dirs.add(join(process.env.APPDATA, 'Godot', 'export_templates', parsedVersion));
  dirs.add(join(homedir(), 'Library', 'Application Support', 'Godot', 'export_templates', parsedVersion));
  return [...dirs];
}

function isAndroid(platform: string): boolean {
  return platform.toLowerCase() === 'android';
}

async function enginePath(engine: string, path: string): Promise<string> {
  if (process.platform !== 'linux' || !/\.exe$/i.test(engine)) return path;
  const bridged = await runCommand('wslpath', ['-w', path], { timeoutMs: 5_000 });
  if (bridged.timedOut || bridged.exitCode !== 0 || !bridged.stdout.trim()) {
    throw new Error(`Could not convert a project path for the Windows Godot executable: ${redactOutput(bridged.stderr || bridged.stdout)}`);
  }
  return bridged.stdout.trim();
}

const knownFeatures = new Set([
  'linux', 'windows', 'macos', 'android', 'ios', 'web', 'desktop', 'mobile',
  'x86_64', 'x86_32', 'arm64', 'arm32', 'rv64', 'ppc64', 'ppc32', 'loongarch64',
  'debug', 'release', 'template', 'template_debug', 'template_release',
]);

async function extensionCheck(project: string, report: PresetReport, mode: string, architectures: string[]): Promise<Check> {
  const extensions = report.extensions ?? [];
  const incomplete = report.scan_incomplete ?? [];
  const ignored = report.scan_ignored ?? [];
  const evidence: string[] = [];
  if (!Array.isArray(report.extensions) || !Array.isArray(report.scan_incomplete)) {
    return check('gdextension', 'unknown', ['Godot did not report complete extension scan coverage.'],
      'Retry the configuration probe and verify extension discovery.');
  }
  if (ignored.length) evidence.push(`Skipped ${ignored.length} director${ignored.length === 1 ? 'y' : 'ies'} containing .gdignore.`);
  if (incomplete.length) evidence.push(`Extension scan incomplete at: ${incomplete.join(', ')}.`);
  if (!extensions.length) {
    return incomplete.length
      ? check('gdextension', 'unknown', evidence, 'Make the skipped directories readable and retry.')
      : check('gdextension', 'passed', [...evidence, 'No .gdextension files found in scanned project directories.']);
  }
  const platformNames: Record<string, string> = { Linux: 'linux', 'Linux/X11': 'linux', 'Windows Desktop': 'windows', macOS: 'macos', Android: 'android' };
  const platform = platformNames[report.platform ?? ''];
  if (!platform || !architectures.length || architectures.includes('universal')) {
    return check('gdextension', 'unknown', [...evidence, 'Target platform or architecture feature selection is not fully determined.'],
      'Select explicit target architectures and verify extension libraries in Godot.');
  }
  let missing = false;
  const custom = (report.custom_features ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const maybeMatch = (key: string, features: Set<string>) => {
    let unknown = false;
    for (const tag of key.split('.').map(s => s.trim())) {
      if (features.has(tag)) continue;
      if (knownFeatures.has(tag)) return false;
      unknown = true;
    }
    return unknown ? undefined : true;
  };
  for (const extension of extensions) {
    if (!extension.readable) {
      evidence.push(`${extension.path}: configuration could not be read.`);
      continue;
    }
    for (const arch of architectures) {
      const features = new Set([platform, platform === 'android' ? 'mobile' : 'desktop', arch, mode, 'template', `template_${mode}`, ...custom]);
      const libraries = Object.entries(extension.libraries ?? {});
      const matches = libraries.map(([tags, value], order) => ({
        tags, value, order, result: maybeMatch(tags, features), count: tags.split('.').length,
      }));
      const best = matches.filter(entry => entry.result === true)
        .sort((a, b) => b.count - a.count || a.order - b.order)[0];
      const uncertain = matches.some(entry => entry.result === undefined && (!best || entry.count > best.count || (entry.count === best.count && entry.order < best.order)));
      const prefix = `${extension.path} (${platform}, ${arch}, ${mode})`;
      if (uncertain || (!best && extension.autodetect)) {
        evidence.push(`${prefix}: library selection depends on unknown features or autodetection.`);
        continue;
      }
      if (!best) {
        missing = true;
        evidence.push(`${prefix}: no matching library entry.`);
        continue;
      }
      if (typeof best.value !== 'string' || !best.value) {
        evidence.push(`${prefix}: selected library entry is invalid.`);
        continue;
      }
      const entries: string[] = [best.value];
      const dependencies = Object.entries(extension.dependencies ?? {});
      for (const [tags, values] of dependencies) {
        const selected = maybeMatch(tags, features);
        if (selected === undefined) {
          evidence.push(`${prefix}: dependency selection depends on unknown features (${tags}).`);
          break;
        }
        if (selected) {
          if (Array.isArray(values) && values.every(value => typeof value === 'string')) entries.push(...values);
          else evidence.push(`${prefix}: selected dependency entry is invalid.`);
          break;
        }
      }
      for (const entry of entries) {
        if (process.platform !== 'win32' && win32.isAbsolute(entry)) {
          evidence.push(`${prefix}: cannot inspect Windows path ${entry} from this host.`);
          continue;
        }
        const extensionPath = extension.path.replace(/\\/g, '/');
        const path = entry.startsWith('res://')
          ? resolve(project, entry.slice(6))
          : isAbsolute(entry) ? entry : resolve(project, dirname(extensionPath), entry);
        try {
          await stat(path);
          evidence.push(`${prefix}: selected ${displayPath(project, path)} exists.`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            missing = true;
            evidence.push(`${prefix}: selected ${displayPath(project, path)} is missing.`);
          } else {
            evidence.push(`${prefix}: cannot inspect ${displayPath(project, path)}.`);
          }
        }
      }
    }
  }
  evidence.push('Library presence does not verify native compatibility, loading, or all export features.');
  return check('gdextension', missing ? 'missing' : 'unknown', evidence,
    'Verify the selected libraries, dependencies, and native compatibility for the target.');
}

export async function handle(this: GodotServer, input: any) {
  let project: string;
  let args: any;
  let presetName: string;
  try {
    args = this.normalizeParameters(input ?? {});
    project = await requireProject(args.projectPath);
    if (typeof args.preset !== 'string' || !args.preset.trim() || !['debug', 'release'].includes(args.mode)) {
      throw new Error('Provide an exact preset name and mode debug or release.');
    }
    presetName = args.preset;
  } catch (error) {
    return jsonResult({ status: 'invalid_request', ready: false, checks: [], message: String(error) }, true);
  }

  const checks: Check[] = [];
  let version = '';
  let report: PresetReport | undefined;
  let helperEvidence = '';
  let engine: string | undefined;
  let engineCompatible = false;
  try {
    engine = await requireGodot(this);
  } catch (error) {
    checks.push(check('engine_version', 'unknown', [String(error)], 'Set GODOT_PATH to a supported Godot executable.'));
  }
  if (engine) {
    try {
      const result = await runCommand(engine, ['--version'], { timeoutMs: 15_000 });
      version = stripVTControlCharacters(result.stdout).trim().split(/\r?\n/)[0] ?? '';
      if (result.timedOut || result.exitCode !== 0 || !version) {
        checks.push(check('engine_version', 'unknown', [
          result.timedOut ? 'Godot version query timed out.' : `Godot exited with code ${result.exitCode}.`,
          redactOutput(result.stderr || result.stdout),
        ].filter(Boolean), 'Verify the configured Godot executable and retry.'));
      } else if (!version.startsWith('4.')) {
        checks.push(check('engine_version', 'unsupported', [`Godot reported ${version}; this probe requires Godot 4.`],
          'Use a supported Godot 4 executable.'));
      } else {
        engineCompatible = true;
        checks.push(check('engine_version', 'passed', [`Godot reported ${version}.`]));
      }
    } catch (error) {
      checks.push(check('engine_version', 'unknown', [redactOutput(String(error))], 'Verify the configured Godot executable and retry.'));
    }
  }

  const presetsFile = join(project, 'export_presets.cfg');
  if (!(await fileExists(presetsFile))) {
    checks.push(check('preset', 'missing', ['export_presets.cfg is absent.'], 'Create the requested export preset in the Godot editor.'));
  } else if (!engine || !engineCompatible) {
    checks.push(check('preset', 'unknown', ['Preset configuration exists, but a compatible Godot 4 executable could not be queried safely.']));
  } else {
    try {
      const projectArgument = await enginePath(engine, project);
      const helperArgument = await enginePath(engine, scriptPath('check-export-readiness.gd'));
      const result = await runCommand(engine, [
        '--headless', '--script', helperArgument, '--',
        projectArgument, presetName, args.mode,
      ], { cwd: dirname(scriptPath('check-export-readiness.gd')), timeoutMs: 30_000 });
      const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith('CHECK_EXPORT_READINESS_JSON:'));
      helperEvidence = redactOutput(result.stderr || result.stdout);
      if (result.timedOut || !marker) {
        checks.push(check('preset', 'unknown', [
          result.timedOut ? 'Godot configuration probe timed out.' : `Godot configuration probe exited with code ${result.exitCode}.`,
          helperEvidence || 'Godot did not return structured preset evidence.',
        ].filter(Boolean), 'Retry with a compatible Godot 4 executable; the probe does not run an export.'));
      } else {
        report = JSON.parse(marker.slice('CHECK_EXPORT_READINESS_JSON:'.length)) as PresetReport;
        if (report.error) {
          checks.push(check('preset', 'unsupported', [redactOutput(report.error)], 'Check that export_presets.cfg is readable by this Godot version.'));
        } else if (result.exitCode !== 0) {
          checks.push(check('preset', 'unknown', [
            `Godot configuration probe exited with code ${result.exitCode}.`,
            helperEvidence,
          ].filter(Boolean), 'Retry with a compatible Godot 4 executable.'));
        } else if (!report.preset_found) {
          checks.push(check('preset', 'missing', [`No exact preset named "${presetName}" was found.`],
            'Use the exact preset name shown in export_presets.cfg.'));
        } else {
          checks.push(check('preset', 'passed', [
            `Godot read the exact preset "${presetName}".`,
            `Target platform: ${report.platform || 'not reported'}.`,
          ]));
        }
      }
    } catch (error) {
      checks.push(check('preset', 'unknown', [redactOutput(String(error))], 'Retry with a compatible Godot 4 executable.'));
    }
  }

  const platform = report?.platform ?? '';
  const options = report?.options ?? {};
  const configuredArchitecture = asString(options['binary_format/architecture']);
  const androidAbis: Record<string, string> = {
    'armeabi-v7a': 'arm32', 'arm64-v8a': 'arm64', x86: 'x86_32', x86_64: 'x86_64',
  };
  const androidComplete = Object.keys(androidAbis)
    .every(abi => typeof options[`architectures/${abi}`] === 'boolean');
  const architectureOptions = isAndroid(platform) && androidComplete
    ? Object.entries(androidAbis).filter(([abi]) => options[`architectures/${abi}`] === true).map(([, arch]) => arch)
    : [];
  const selectedArchitectures = isAndroid(platform) ? architectureOptions
    : configuredArchitecture ? [configuredArchitecture] : [];
  if (!report?.preset_found) {
    checks.push(check('target_architecture', 'unknown', ['Target architecture cannot be determined without a readable matching preset.']));
    checks.push(check('export_templates', 'unknown', ['Template selection cannot be determined without a readable matching preset.']));
    checks.push(check('gdextension', 'unknown', ['Selected-platform GDExtension dependencies cannot be determined without a matching preset.']));
  } else {
    const selected = selectedArchitectures.length ? selectedArchitectures.join(', ') : undefined;
    checks.push(selected
      ? check('target_architecture', 'passed', [`Preset selects architecture(s): ${selected}.`])
      : check('target_architecture', 'unknown', [
        'The preset does not explicitly identify a target architecture in the settings inspected.',
      ], 'Select the target architecture in the export preset and verify platform defaults in Godot.'));

    const gradleEnabled = isAndroid(platform) && options['gradle_build/use_gradle_build'] === true;
    const gradleUnknown = isAndroid(platform) && typeof options['gradle_build/use_gradle_build'] !== 'boolean';
    const customTemplate = !gradleEnabled && !gradleUnknown ? asString(options[`custom_template/${args.mode}`]) : undefined;
    if (gradleEnabled) {
      checks.push(check('export_templates', 'passed', ['The Android preset enables Gradle; APK templates are not used.']));
    } else if (gradleUnknown) {
      checks.push(check('export_templates', 'unknown', ['Effective Android Gradle setting is unknown, so the applicable template cannot be selected.']));
    } else if (customTemplate) {
      const localTemplate = customTemplate.startsWith('res://') ? customTemplate.slice('res://'.length) : customTemplate;
      const inaccessible = process.platform !== 'win32' && win32.isAbsolute(localTemplate);
      const templatePath = isAbsolute(localTemplate) || inaccessible ? localTemplate : resolve(project, localTemplate);
      const state = inaccessible ? 'unknown' : await fileState(templatePath);
      checks.push(state !== 'missing'
        ? check('export_templates', 'unknown', [
          ...(state === 'unknown' ? [`Cannot inspect custom ${args.mode} template at ${displayPath(project, templatePath)}.`] : [
          `Custom ${args.mode} template exists at ${displayPath(project, templatePath)}.`,
          'File presence does not establish that the template is compatible with this Godot version or target.']),
        ], 'Confirm the template version and platform compatibility in Godot.')
        : check('export_templates', 'missing', [`Custom ${args.mode} template is missing: ${displayPath(project, templatePath)}.`],
          'Install a compatible custom template or select a standard template.'));
    } else if (report.standard_template && typeof report.standard_template.exists === 'boolean') {
      const { path, exists } = report.standard_template;
      checks.push(check('export_templates', exists ? 'unknown' : 'missing', [
        `Godot's ${args.mode} standard template ${exists ? 'exists' : 'is missing'}: ${path}.`,
        ...(exists ? ['File presence does not establish template compatibility.'] : []),
      ], 'Install and verify the corresponding Godot export template.'));
    } else if (version) {
      const candidates = templateCandidates(version);
      const existing = [];
      for (const candidate of candidates) if (await directoryExists(candidate)) existing.push(candidate);
      checks.push(check('export_templates', 'unknown', [
        existing.length
          ? `Template directory candidate(s) exist: ${existing.map(path => displayPath(project, path)).join(', ')}.`
          : `No standard template directory was found among the usual locations for ${version}.`,
        'Godot editor template settings and selected platform template compatibility are not exposed by this safe preflight.',
      ], 'Confirm the exact standard template in Godot Editor Settings > Export > Templates.'));
    } else {
      checks.push(check('export_templates', 'unknown', ['Godot version is unavailable, so standard template locations cannot be checked.']));
    }

    checks.push(await extensionCheck(project, report, args.mode, selectedArchitectures));
  }

  if (isAndroid(platform)) {
    const hostDiffers = !!report?.host_os && ((report.host_os === 'Windows') !== (process.platform === 'win32'));
    const configuredJava = hostDiffers ? undefined : await editorSetting(project, 'export/android/java_sdk_path');
    const configuredSdk = hostDiffers ? undefined : await editorSetting(project, 'export/android/android_sdk_path');
    const javaEnvCandidates = [process.env.JAVA_HOME].filter((path): path is string => !!path);
    const sdkEnvCandidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
      .filter((path): path is string => !!path);
    const javaCandidates = configuredJava ? [configuredJava] : javaEnvCandidates;
    const sdkCandidates = configuredSdk ? [configuredSdk] : sdkEnvCandidates;
    const javaCandidateStates = await Promise.all(javaCandidates.map(directoryState));
    const sdkCandidateStates = await Promise.all(sdkCandidates.map(directoryState));
    const javaFound = javaCandidateStates.includes('present');
    const sdkFound = sdkCandidateStates.includes('present');
    const javaMissing = !!configuredJava && javaCandidateStates[0] === 'missing';
    const sdkMissing = !!configuredSdk && sdkCandidateStates[0] === 'missing';
    const isWindows = report?.host_os === 'Windows' || (!report?.host_os && process.platform === 'win32');
    const javaFile = isWindows ? 'java.exe' : 'java';
    const adbFile = isWindows ? 'adb.exe' : 'adb';
    const signerFile = isWindows ? 'apksigner.bat' : 'apksigner';
    const javaCommandState = configuredJava && javaFound ? await fileState(join(configuredJava, 'bin', javaFile)) : 'unknown';
    const javaCommandMissing = javaCommandState === 'missing';
    let sdkComponentsMissing = false;
    const sdkEvidence: string[] = [];
    if (configuredSdk && sdkFound) {
      const adbPath = join(configuredSdk, 'platform-tools', adbFile);
      const adbState = await fileState(adbPath);
      if (adbState === 'missing') {
        sdkComponentsMissing = true;
        sdkEvidence.push(`Required platform-tools/${adbFile} is missing.`);
      } else if (adbState === 'unknown') {
        sdkEvidence.push(`Cannot inspect platform-tools/${adbFile}.`);
      }
      const buildTools = join(configuredSdk, 'build-tools');
      try {
        const versions = await readdir(buildTools, { withFileTypes: true });
        const signers = await Promise.all(versions.filter(item => item.isDirectory() || item.isSymbolicLink())
          .map(item => fileState(join(buildTools, item.name, signerFile))));
        if (!signers.includes('present') && !signers.includes('unknown')) {
          sdkComponentsMissing = true;
          sdkEvidence.push(`No ${signerFile} found in SDK build-tools versions.`);
        } else if (!signers.includes('present')) {
          sdkEvidence.push(`Could not inspect SDK build-tools ${signerFile} candidates.`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          sdkComponentsMissing = true;
          sdkEvidence.push('Required SDK build-tools directory is missing.');
        } else {
          sdkEvidence.push('SDK build-tools directory could not be inspected.');
        }
      }
    }
    checks.push(check('android_jdk', javaMissing || javaCommandMissing ? 'missing' : 'unknown', [
      configuredJava ? `Godot editor JDK setting is configured${javaFound ? ' and its path exists' : javaMissing ? ', but its path is missing' : ', but its path could not be inspected'}.`
        : javaEnvCandidates.length ? `JAVA_HOME path candidate(s) ${javaFound ? 'exist' : 'are missing'}; Godot may use a separate editor setting.`
          : 'Godot editor JDK settings were not found and JAVA_HOME is unset.',
      ...(javaCommandMissing ? [`Required bin/${javaFile} is missing.`] : []),
      'The configured JDK version and Godot export compatibility cannot be established by this non-building check.',
    ], 'Set and verify the supported JDK path in Godot Editor Settings > Export > Android.'));
    checks.push(check('android_sdk', sdkMissing || sdkComponentsMissing ? 'missing' : 'unknown', [
      configuredSdk ? `Godot editor Android SDK setting is configured${sdkFound ? ' and its path exists' : sdkMissing ? ', but its path is missing' : ', but its path could not be inspected'}.`
        : sdkEnvCandidates.length ? `ANDROID_HOME/ANDROID_SDK_ROOT path candidate(s) ${sdkFound ? 'exist' : 'are missing'}; Godot may use a separate editor setting.`
          : 'Godot editor Android SDK settings were not found and Android SDK environment variables are unset.',
      ...sdkEvidence,
      'SDK platforms, build-tools, API compatibility, and selected export requirements were not validated.',
    ], 'Set and verify the supported Android SDK path and required components in Godot Editor Settings > Export > Android.'));

    const gradle = options['gradle_build/use_gradle_build'];
    if (gradle === false) {
      checks.push(check('android_gradle', 'passed', ['The selected preset explicitly disables Gradle build.']));
    } else if (gradle === true) {
      const configuredDir = asString(options['gradle_build/gradle_build_directory']) ?? 'res://android';
      const inaccessible = process.platform !== 'win32' && win32.isAbsolute(configuredDir);
      const buildBase = inaccessible ? configuredDir : configuredDir.startsWith('res://') ? resolve(project, configuredDir.slice(6))
        : isAbsolute(configuredDir) ? configuredDir : resolve(project, configuredDir);
      const buildDir = join(buildBase, 'build');
      let buildState: CheckStatus = 'unknown';
      let detail = `Installed Gradle build directory exists: ${displayPath(project, buildDir)}.`;
      try {
        if (inaccessible) throw new Error('Configured directory is on an inaccessible Windows filesystem.');
        if (!(await stat(buildDir)).isDirectory()) {
          buildState = 'missing';
          detail = `Installed Gradle build directory is not a directory: ${displayPath(project, buildDir)}.`;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          buildState = 'missing';
          detail = `Installed Gradle build directory is missing: ${displayPath(project, buildDir)}.`;
        } else detail = `Installed Gradle build directory could not be inspected: ${displayPath(project, buildDir)}.`;
      }
      const marker = join(buildBase, '.build_version');
      let markerState = inaccessible ? 'unknown' : await fileState(marker);
      if (markerState === 'present') {
        try {
          const file = await open(marker, 'r');
          await file.close();
        } catch (error) {
          markerState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
        }
      }
      const markerDetail = `Gradle template version marker ${markerState === 'present' ? 'exists' : markerState === 'missing' ? 'is missing' : 'could not be inspected'}: ${displayPath(project, marker)}.`;
      checks.push(check('android_gradle', buildState === 'missing' || markerState === 'missing' ? 'missing' : 'unknown', [detail, markerDetail,
        'Presence does not verify the Gradle template version or build requirements.'],
      'Install and verify the Android build template and its SDK/JDK requirements in Godot.'));
    } else {
      checks.push(check('android_gradle', 'unknown', [
        'The preset does not expose an explicit Gradle-build setting; the effective Godot export setting is unknown.',
      ], 'Check the effective Gradle build setting in the Godot Android export preset.'));
    }
  }

  const ready = checks.length > 0 && checks.every(item => item.status === 'passed');
  const status = ready ? 'ready'
    : checks.some(item => item.status === 'missing' || item.status === 'unsupported') ? 'not_ready'
      : 'inconclusive';
  return jsonResult({
    status,
    ready,
    projectPath: project,
    preset: presetName,
    mode: args.mode,
    platform: platform || null,
    checks,
    limitations: [
      'This preflight does not build, publish, install dependencies, or execute project scripts.',
      'Unknown checks are not treated as ready; standard editor settings, platform feature selection, or compatibility may require manual verification.',
    ],
  });
}

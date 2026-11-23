import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GodotServer } from '../index.ts';
import { handle } from './check-export-readiness.ts';

test('check_export_readiness is non-building, reports uncertainty, and never returns preset secrets', {
  skip: process.platform === 'win32',
}, async () => {
  const project = await mkdtemp(join(process.cwd(), '.check-export-readiness-test-'));
  const env = Object.fromEntries(
    ['HOME', 'XDG_DATA_HOME', 'APPDATA', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'CHECK_GODOT_VERSION', 'CHECK_TEMPLATE_PRESENT', 'CHECK_GRADLE_BASE']
      .map(key => [key, process.env[key]]),
  );
  const engine = join(project, 'fake-godot');
  const calls = join(project, 'calls.jsonl');
  const server = {
    godotPath: engine,
    normalizeParameters: (args: unknown) => args,
  } as unknown as GodotServer;
  const invoke = (preset: string) => handle.call(server, {
    projectPath: project,
    preset,
    mode: 'debug',
  });
  try {
    process.env.HOME = project;
    process.env.XDG_DATA_HOME = join(project, 'xdg');
    delete process.env.APPDATA;
    delete process.env.JAVA_HOME;
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    await writeFile(join(project, 'project.godot'), 'config_version=5\n');
    await writeFile(join(project, 'export_presets.cfg'), [
      '[preset.0]',
      'name="Desktop"',
      'platform="Linux"',
      '[preset.0.options]',
      'binary_format/architecture="x86_64"',
      'custom_template/debug="custom-template"',
      'keystore/password="never-return-this"',
      '',
    ].join('\n'));
    await writeFile(join(project, 'custom-template'), 'placeholder');
    await mkdir(join(project, 'addons', 'native'), { recursive: true });
    await mkdir(join(project, 'bin'), { recursive: true });
    await writeFile(join(project, 'addons', 'native', 'ext.gdextension'), '[configuration]\n');
    await writeFile(join(project, 'bin', 'libgdextension.so'), 'placeholder');
    await writeFile(engine, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) {
  console.log(process.env.CHECK_GODOT_VERSION || '4.4.1.stable');
} else {
  const preset = args.at(-2);
  if (preset === 'Unreadable') {
    console.log('CHECK_EXPORT_READINESS_JSON:' + JSON.stringify({ error: 'Godot could not read export_presets.cfg.' }));
    process.exitCode = 1;
  } else {
    const android = preset === 'Android' || preset === 'Partial Android';
    console.log('CHECK_EXPORT_READINESS_JSON:' + JSON.stringify({
      preset_found: preset === 'Desktop' || preset === 'Standard' || preset === 'Incomplete' || android,
      platform: android ? 'Android' : 'Linux',
      options: preset === 'Partial Android'
        ? { 'architectures/arm64-v8a': true, 'gradle_build/use_gradle_build': true }
        : android
        ? { 'architectures/armeabi-v7a': false, 'architectures/arm64-v8a': true,
            'architectures/x86': false, 'architectures/x86_64': false, 'gradle_build/use_gradle_build': true,
            'gradle_build/gradle_build_directory': process.env.CHECK_GRADLE_BASE || '' }
        : preset === 'Standard' ? { 'binary_format/architecture': 'x86_64' }
          : { 'binary_format/architecture': 'x86_64', 'custom_template/debug': 'custom-template' },
      standard_template: { path: 'linux_debug.x86_64', exists: process.env.CHECK_TEMPLATE_PRESENT === 'yes' },
      scan_incomplete: preset === 'Incomplete' ? ['unreadable'] : [],
      extensions: android
        ? [{ path: 'addons/native/ext.gdextension', readable: true,
             libraries: { 'android.debug.arm64': 'res://bin/libgdextension.so', 'windows.debug.x86_64': 'res://bin/windows-only.dll' },
             dependencies: { 'android.arm64': ['res://bin/missing.so'] } }]
        : [],
    }));
  }
}
`, { mode: 0o755 });
    await chmod(engine, 0o755);

    const desktop = await invoke('Desktop');
    assert.equal(desktop.structuredContent?.ready, false);
    assert.equal(desktop.structuredContent?.status, 'inconclusive');
    const desktopChecks = desktop.structuredContent?.checks as { name: string; status: string; evidence: string[] }[];
    assert.equal(desktopChecks.find(item => item.name === 'target_architecture')?.status, 'passed');
    assert.equal(desktopChecks.find(item => item.name === 'export_templates')?.status, 'unknown');
    assert.match(desktopChecks.find(item => item.name === 'export_templates')?.evidence.join(' ') ?? '', /compatib/i);
    assert.equal(desktopChecks.find(item => item.name === 'gdextension')?.status, 'passed');

    const android = await invoke('Android');
    assert.equal(android.structuredContent?.ready, false);
    const androidChecks = android.structuredContent?.checks as { name: string; status: string; evidence: string[] }[];
    assert.equal(androidChecks.find(item => item.name === 'android_jdk')?.status, 'unknown');
    assert.equal(androidChecks.find(item => item.name === 'android_sdk')?.status, 'unknown');
    assert.equal(androidChecks.find(item => item.name === 'android_gradle')?.status, 'missing');
    assert.equal(androidChecks.find(item => item.name === 'gdextension')?.status, 'missing');
    assert.match(androidChecks.find(item => item.name === 'gdextension')?.evidence.join(' ') ?? '', /missing/);
    const partialAndroid = await invoke('Partial Android');
    const partialChecks = partialAndroid.structuredContent?.checks as { name: string; status: string }[];
    assert.equal(partialChecks.find(item => item.name === 'target_architecture')?.status, 'unknown');
    assert.equal(partialChecks.find(item => item.name === 'gdextension')?.status, 'unknown');
    await mkdir(join(project, 'android', 'build'), { recursive: true });
    await writeFile(join(project, 'bin', 'missing.so'), 'placeholder');
    const markerMissing = await invoke('Android');
    const missingMarkerCheck = (markerMissing.structuredContent?.checks as { name: string; status: string; evidence: string[] }[])
      .find(item => item.name === 'android_gradle');
    assert.equal(missingMarkerCheck?.status, 'missing');
    assert.match(missingMarkerCheck?.evidence.join(' ') ?? '', /version marker is missing.*android\/\.build_version/);
    await symlink('.build_version', join(project, 'android', '.build_version'));
    const markerUnreadable = await invoke('Android');
    const unreadableMarkerCheck = (markerUnreadable.structuredContent?.checks as { name: string; status: string; evidence: string[] }[])
      .find(item => item.name === 'android_gradle');
    assert.equal(unreadableMarkerCheck?.status, 'unknown');
    assert.match(unreadableMarkerCheck?.evidence.join(' ') ?? '', /marker could not be inspected/);
    await rm(join(project, 'android', '.build_version'));
    await writeFile(join(project, 'android', '.build_version'), '4.4.1.stable');
    const presentAndroid = await invoke('Android');
    const presentChecks = presentAndroid.structuredContent?.checks as { name: string; status: string; evidence: string[] }[];
    assert.equal(presentChecks.find(item => item.name === 'android_gradle')?.status, 'unknown');
    assert.equal(presentChecks.find(item => item.name === 'gdextension')?.status, 'unknown');
    assert.doesNotMatch(presentChecks.find(item => item.name === 'gdextension')?.evidence.join(' ') ?? '', /windows-only/);
    await mkdir(join(project, 'custom-android', 'build'), { recursive: true });
    process.env.CHECK_GRADLE_BASE = 'res://custom-android';
    const customGradle = await invoke('Android');
    const customCheck = (customGradle.structuredContent?.checks as { name: string; status: string; evidence: string[] }[])
      .find(item => item.name === 'android_gradle');
    assert.equal(customCheck?.status, 'missing');
    assert.match(customCheck?.evidence.join(' ') ?? '', /custom-android\/\.build_version/);
    delete process.env.CHECK_GRADLE_BASE;

    const standardMissing = await invoke('Standard');
    assert.equal((standardMissing.structuredContent?.checks as { name: string; status: string }[])
      .find(item => item.name === 'export_templates')?.status, 'missing');
    process.env.CHECK_TEMPLATE_PRESENT = 'yes';
    const standardPresent = await invoke('Standard');
    assert.equal((standardPresent.structuredContent?.checks as { name: string; status: string }[])
      .find(item => item.name === 'export_templates')?.status, 'unknown');
    delete process.env.CHECK_TEMPLATE_PRESENT;
    const incomplete = await invoke('Incomplete');
    const incompleteCheck = (incomplete.structuredContent?.checks as { name: string; status: string; evidence: string[] }[])
      .find(item => item.name === 'gdextension');
    assert.equal(incompleteCheck?.status, 'unknown');
    assert.match(incompleteCheck?.evidence.join(' ') ?? '', /unreadable/);

    await mkdir(join(project, '.config', 'godot'), { recursive: true });
    await writeFile(join(project, '.config', 'godot', 'editor_settings-4.tres'), [
      '[resource]',
      'export/android/java_sdk_path = "/missing/jdk"',
      'export/android/android_sdk_path = "/missing/sdk"',
      'export/android/keystore_pass = "must-not-be-returned"',
      '',
    ].join('\n'));
    const configuredAndroid = await invoke('Android');
    const configuredAndroidChecks = configuredAndroid.structuredContent?.checks as { name: string; status: string }[];
    assert.equal(configuredAndroidChecks.find(item => item.name === 'android_jdk')?.status, 'missing');
    assert.equal(configuredAndroidChecks.find(item => item.name === 'android_sdk')?.status, 'missing');
    const jdk = join(project, 'jdk');
    const sdk = join(project, 'sdk');
    await mkdir(jdk, { recursive: true });
    await mkdir(sdk, { recursive: true });
    await writeFile(join(project, '.config', 'godot', 'editor_settings-4.tres'), [
      `[resource]`,
      `export/android/java_sdk_path = "${jdk}"`,
      `export/android/android_sdk_path = "${sdk}"`,
    ].join('\n'));
    const missingCommands = await invoke('Android');
    const missingCommandChecks = missingCommands.structuredContent?.checks as { name: string; status: string }[];
    assert.equal(missingCommandChecks.find(item => item.name === 'android_jdk')?.status, 'missing');
    assert.equal(missingCommandChecks.find(item => item.name === 'android_sdk')?.status, 'missing');
    await mkdir(join(jdk, 'bin'), { recursive: true });
    await mkdir(join(sdk, 'platform-tools'), { recursive: true });
    await mkdir(join(sdk, 'build-tools', '35'), { recursive: true });
    await writeFile(join(jdk, 'bin', 'java'), '');
    await writeFile(join(sdk, 'platform-tools', 'adb'), '');
    await writeFile(join(sdk, 'build-tools', '35', 'apksigner'), '');
    const presentCommands = await invoke('Android');
    const presentCommandChecks = presentCommands.structuredContent?.checks as { name: string; status: string }[];
    assert.equal(presentCommandChecks.find(item => item.name === 'android_jdk')?.status, 'unknown');
    assert.equal(presentCommandChecks.find(item => item.name === 'android_sdk')?.status, 'unknown');

    const missing = await invoke('Not a preset');
    assert.equal(missing.structuredContent?.status, 'not_ready');
    assert.equal((missing.structuredContent?.checks as { name: string; status: string }[])
      .find(item => item.name === 'preset')?.status, 'missing');
    const unreadable = await invoke('Unreadable');
    assert.equal((unreadable.structuredContent?.checks as { name: string; status: string }[])
      .find(item => item.name === 'preset')?.status, 'unsupported');
    process.env.CHECK_GODOT_VERSION = '3.5.stable';
    const unsupported = await invoke('Desktop');
    assert.equal((unsupported.structuredContent?.checks as { name: string; status: string }[])
      .find(item => item.name === 'engine_version')?.status, 'unsupported');
    assert.equal(unsupported.structuredContent?.ready, false);
    const output = JSON.stringify([desktop.structuredContent, android.structuredContent, configuredAndroid.structuredContent, missing.structuredContent]);
    assert.doesNotMatch(output, /never-return-this|must-not-be-returned/);

    const callsMade = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.ok(callsMade.every(args => !args.some(arg => arg.startsWith('--export-'))));
    assert.ok(callsMade.some(args => args.includes('--script')));
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(project, { recursive: true, force: true });
  }
});

test('check_export_readiness parses and runs its GDScript probe with a real Godot executable', {
  skip: !process.env.GODOT_TEST_BIN,
}, async () => {
  const project = await mkdtemp(join(process.cwd(), '.check-export-readiness-godot-test-'));
  const server = {
    godotPath: process.env.GODOT_TEST_BIN,
    normalizeParameters: (args: unknown) => args,
  } as unknown as GodotServer;
  try {
    await writeFile(join(project, 'project.godot'), [
      'config_version=5',
      '[autoload]',
      'ReadinessSentinel="*res://readiness-autoload.gd"',
      '',
    ].join('\n'));
    await writeFile(join(project, 'readiness-autoload.gd'), [
      'extends Node',
      'func _init():',
      '\tFileAccess.open("res://autoload-ran", FileAccess.WRITE)',
      '',
    ].join('\n'));
    await writeFile(join(project, 'export_presets.cfg'), [
      '[preset.0]',
      'name="Fixture Linux"',
      'platform="Linux"',
      '[preset.0.options]',
      'binary_format/architecture="x86_64"',
      '[preset.1]',
      'name="Fixture Android"',
      'platform="Android"',
      '[preset.1.options]',
      'architectures/armeabi-v7a=false',
      'architectures/arm64-v8a=true',
      'architectures/x86=false',
      'architectures/x86_64=false',
      'gradle_build/use_gradle_build=true',
      '',
    ].join('\n'));

    const result = await handle.call(server, {
      projectPath: project,
      preset: 'Fixture Linux',
      mode: 'debug',
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    const checks = result.structuredContent?.checks as { name: string; status: string; evidence: string[] }[];
    assert.equal(checks.find(item => item.name === 'engine_version')?.status, 'passed', JSON.stringify(result.structuredContent));
    assert.equal(checks.find(item => item.name === 'preset')?.status, 'passed', JSON.stringify(result.structuredContent));
    assert.equal(checks.find(item => item.name === 'target_architecture')?.status, 'passed', JSON.stringify(result.structuredContent));
    assert.match(checks.find(item => item.name === 'export_templates')?.evidence.join(' ') ?? '', /linux_debug\.x86_64/);
    assert.equal(result.structuredContent?.ready, false);
    await assert.rejects(access(join(project, 'autoload-ran')));

    await mkdir(join(project, 'addons', 'native'), { recursive: true });
    await mkdir(join(project, 'ignored'), { recursive: true });
    await writeFile(join(project, 'ignored', '.gdignore'), '');
    await writeFile(join(project, 'ignored', 'ignored.gdextension'), '[libraries]\nlinux.debug.x86_64="res://ignore-me.so"\n');
    await writeFile(join(project, 'addons', 'native', 'test.gdextension'), [
      '[configuration]',
      'entry_symbol="test_init"',
      '[libraries]',
      'windows.debug.x86_64="res://windows-only.dll"',
      'linux.release.x86_64="res://linux-release.so"',
      'linux.debug.x86_64="res://linux-debug.so"',
      'android.debug.arm64="res://android-arm64.so"',
      '[dependencies]',
      'linux.x86_64={"linux-dependency.so": ""}',
      '',
    ].join('\n'));
    await writeFile(join(project, 'linux-debug.so'), '');
    const invoke = () => handle.call(server, { projectPath: project, preset: 'Fixture Linux', mode: 'debug' });
    const missingDependency = await invoke();
    const extensionCheck = (value: typeof result) => (value.structuredContent?.checks as { name: string; status: string; evidence: string[] }[])
      .find(item => item.name === 'gdextension');
    assert.equal(extensionCheck(missingDependency)?.status, 'missing', JSON.stringify(missingDependency.structuredContent));
    const evidence = extensionCheck(missingDependency)?.evidence.join(' ') ?? '';
    assert.match(evidence, /linux-dependency\.so/);
    assert.doesNotMatch(evidence, /windows-only|linux-release|ignore-me/);
    await writeFile(join(project, 'addons', 'native', 'linux-dependency.so'), '');
    const allPresent = await invoke();
    assert.equal(extensionCheck(allPresent)?.status, 'unknown', JSON.stringify(allPresent.structuredContent));
    await rm(join(project, 'linux-debug.so'));
    const missingLibrary = await invoke();
    assert.equal(extensionCheck(missingLibrary)?.status, 'missing', JSON.stringify(missingLibrary.structuredContent));
    assert.match(extensionCheck(missingLibrary)?.evidence.join(' ') ?? '', /linux-debug\.so.*missing/);
    await writeFile(join(project, 'linux-release.so'), '');
    const release = await handle.call(server, { projectPath: project, preset: 'Fixture Linux', mode: 'release' });
    assert.equal(extensionCheck(release)?.status, 'unknown', JSON.stringify(release.structuredContent));
    assert.doesNotMatch(extensionCheck(release)?.evidence.join(' ') ?? '', /linux-debug\.so/);
    assert.match((release.structuredContent?.checks as { name: string; evidence: string[] }[])
      .find(item => item.name === 'export_templates')?.evidence.join(' ') ?? '', /linux_release\.x86_64/);
    const android = await handle.call(server, { projectPath: project, preset: 'Fixture Android', mode: 'debug' });
    const androidEvidence = extensionCheck(android)?.evidence.join(' ') ?? '';
    assert.equal(extensionCheck(android)?.status, 'missing', JSON.stringify(android.structuredContent));
    assert.match(androidEvidence, /android-arm64\.so.*missing/);
    assert.doesNotMatch(androidEvidence, /windows-only|linux-debug|linux-release/);
    assert.equal((android.structuredContent?.checks as { name: string; status: string }[])
      .find(item => item.name === 'target_architecture')?.status, 'passed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

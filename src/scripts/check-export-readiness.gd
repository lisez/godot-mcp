extends SceneTree


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 3:
		_emit({"error": "The readiness probe requires a project path, preset name, and mode."}, 1)
		return

	var project_path: String = args[0]
	var presets := ConfigFile.new()
	var load_error := presets.load(project_path.path_join("export_presets.cfg"))
	if load_error != OK:
		_emit({"error": "Godot could not read export_presets.cfg (error %s)." % load_error}, 1)
		return

	var extension_scan := _read_extensions(project_path)
	var result := {
		"preset_found": false,
		"host_os": OS.get_name(),
		"extensions": extension_scan["extensions"],
		"scan_incomplete": extension_scan["incomplete"],
		"scan_ignored": extension_scan["ignored"],
	}
	var selected_section := ""
	for section in presets.get_sections():
		if not section.begins_with("preset.") or section.ends_with(".options"):
			continue
		if str(presets.get_value(section, "name", "")) == args[1]:
			selected_section = section
			break

	if selected_section.is_empty():
		_emit(result)
		return

	var options_section := selected_section + ".options"
	var options := {}
	for key in [
		"binary_format/architecture",
		"custom_features",
		"custom_template/debug",
		"custom_template/release",
		"gradle_build/use_gradle_build",
		"gradle_build/gradle_build_directory",
		"gradle_build/export_format",
		"architectures/arm64-v8a",
		"architectures/armeabi-v7a",
		"architectures/x86_64",
		"architectures/x86",
	]:
		if presets.has_section_key(options_section, key):
			options[key] = presets.get_value(options_section, key)

	result["preset_found"] = true
	result["platform"] = str(presets.get_value(selected_section, "platform", ""))
	result["custom_features"] = str(presets.get_value(selected_section, "custom_features", ""))
	result["options"] = options
	var template_dir := _template_directory()
	var template_name := _template_name(result["platform"], options, args[2])
	if not template_dir.is_empty() and not template_name.is_empty():
		var template_path := template_dir.path_join(template_name)
		result["standard_template"] = {"path": template_path, "exists": FileAccess.file_exists(template_path)}
	_emit(result)


func _template_directory() -> String:
	var exe_dir := OS.get_executable_path().get_base_dir()
	var data_dir := ""
	if OS.get_name() == "macOS" and exe_dir.ends_with("/Contents/MacOS"):
		var outer_dir := exe_dir.path_join("../../..").simplify_path()
		if FileAccess.file_exists(outer_dir.path_join("._sc_")) or FileAccess.file_exists(outer_dir.path_join("_sc_")):
			exe_dir = outer_dir
	if FileAccess.file_exists(exe_dir.path_join("._sc_")) or FileAccess.file_exists(exe_dir.path_join("_sc_")):
		data_dir = exe_dir.path_join("editor_data")
	elif OS.get_name() == "Windows":
		var appdata := OS.get_environment("APPDATA")
		if not appdata.is_empty():
			data_dir = appdata.path_join("Godot")
	elif OS.get_name() == "macOS":
		var home := OS.get_environment("HOME")
		if not home.is_empty():
			data_dir = home.path_join("Library/Application Support/Godot")
	elif OS.get_name() == "Linux" or OS.get_name() == "FreeBSD" or OS.get_name() == "NetBSD" or OS.get_name() == "OpenBSD":
		var data := OS.get_environment("XDG_DATA_HOME")
		if data.is_empty():
			var home := OS.get_environment("HOME")
			if not home.is_empty():
				data = home.path_join(".local/share")
		if not data.is_empty():
			data_dir = data.path_join("godot")
	if data_dir.is_empty():
		return ""
	var ver := Engine.get_version_info()
	var version := "%s.%s" % [ver["major"], ver["minor"]]
	if ver["patch"] != 0:
		version += ".%s" % ver["patch"]
	version += ".%s" % ver["status"]
	if OS.has_feature("mono"):
		version += ".mono"
	return data_dir.path_join("export_templates").path_join(version)


func _template_name(platform: String, options: Dictionary, mode: String) -> String:
	var arch := str(options.get("binary_format/architecture", ""))
	match platform:
		"Linux", "Linux/X11":
			return "linux_%s.%s" % [mode, arch] if not arch.is_empty() else ""
		"Windows Desktop":
			return "windows_%s_%s.exe" % [mode, arch] if not arch.is_empty() else ""
		"macOS":
			return "macos.zip"
		"Android":
			if options.get("gradle_build/use_gradle_build", null) == false:
				return "android_%s.apk" % mode
	return ""


func _read_extensions(project_path: String) -> Dictionary:
	var result: Array = []
	var incomplete: Array[String] = []
	var ignored: Array[String] = []
	var pending: Array[String] = [project_path]
	while not pending.is_empty():
		var directory_path: String = pending.pop_back()
		var directory := DirAccess.open(directory_path)
		if directory == null:
			incomplete.append(directory_path.trim_prefix(project_path))
			continue
		if directory_path != project_path and FileAccess.file_exists(directory_path.path_join(".gdignore")):
			ignored.append(directory_path.trim_prefix(project_path))
			continue
		if directory.list_dir_begin() != OK:
			incomplete.append(directory_path.trim_prefix(project_path))
			continue
		var entry := directory.get_next()
		while not entry.is_empty():
			var entry_path := directory_path.path_join(entry)
			if directory.is_link(entry_path):
				incomplete.append(entry_path.trim_prefix(project_path))
				entry = directory.get_next()
				continue
			if directory.current_is_dir():
				if entry != "." and entry != ".." and entry != ".godot" and entry != ".git":
					pending.append(entry_path)
			elif entry.ends_with(".gdextension"):
				var extension_path := entry_path
				var config := ConfigFile.new()
				if config.load(extension_path) == OK:
					result.append({
						"path": extension_path.trim_prefix(project_path).trim_prefix("/").trim_prefix("\\"),
						"libraries": _section_entries(config, "libraries"),
						"dependencies": _section_entries(config, "dependencies"),
						"autodetect": str(config.get_value("configuration", "autodetect_library_prefix", "")),
						"readable": true,
					})
				else:
					result.append({
						"path": extension_path.trim_prefix(project_path).trim_prefix("/").trim_prefix("\\"),
						"libraries": {},
						"dependencies": {},
						"readable": false,
					})
			entry = directory.get_next()
		directory.list_dir_end()
	return {"extensions": result, "incomplete": incomplete, "ignored": ignored}


func _section_entries(config: ConfigFile, section: String) -> Dictionary:
	var result := {}
	if not config.has_section(section):
		return result
	for key in config.get_section_keys(section):
		var value: Variant = config.get_value(section, key)
		if value is String:
			result[key] = value
		elif value is Dictionary:
			result[key] = value.keys()
		else:
			result[key] = null
	return result


func _emit(value: Dictionary, exit_code: int = 0) -> void:
	print("CHECK_EXPORT_READINESS_JSON:" + JSON.stringify(value))
	quit(exit_code)

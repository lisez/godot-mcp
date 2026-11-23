extends SceneTree

func _initialize() -> void:
	var results: Array[Dictionary] = []
	for path in OS.get_cmdline_user_args():
		var status := GDExtensionManager.LOAD_STATUS_ALREADY_LOADED
		if not GDExtensionManager.is_extension_loaded(path):
			status = GDExtensionManager.load_extension(path)
		results.append({"path": path, "status": status, "loaded": GDExtensionManager.is_extension_loaded(path)})
	print("GODOT_MCP_EXTENSIONS=" + JSON.stringify(results))
	quit()

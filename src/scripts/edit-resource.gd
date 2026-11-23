extends SceneTree

const MARKER := "GODOT_MCP_RESOURCE="

var visited_resources: Dictionary = {}

func finish(report: Dictionary, exit_code := 0) -> void:
	print(MARKER + JSON.stringify(report))
	quit(exit_code)

func variant_type_name(value: Variant) -> String:
	match typeof(value):
		TYPE_NIL: return "Nil"
		TYPE_BOOL: return "bool"
		TYPE_INT: return "int"
		TYPE_FLOAT: return "float"
		TYPE_STRING: return "String"
		TYPE_STRING_NAME: return "StringName"
		TYPE_NODE_PATH: return "NodePath"
		TYPE_VECTOR2: return "Vector2"
		TYPE_VECTOR2I: return "Vector2i"
		TYPE_VECTOR3: return "Vector3"
		TYPE_VECTOR3I: return "Vector3i"
		TYPE_VECTOR4: return "Vector4"
		TYPE_VECTOR4I: return "Vector4i"
		TYPE_COLOR: return "Color"
		TYPE_ARRAY: return "Array"
		TYPE_DICTIONARY: return "Dictionary"
	return ""

func encode_value(value: Variant) -> Variant:
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(value)
		TYPE_VECTOR2:
			return [value.x, value.y]
		TYPE_VECTOR2I:
			return [value.x, value.y]
		TYPE_VECTOR3:
			return [value.x, value.y, value.z]
		TYPE_VECTOR3I:
			return [value.x, value.y, value.z]
		TYPE_VECTOR4:
			return [value.x, value.y, value.z, value.w]
		TYPE_VECTOR4I:
			return [value.x, value.y, value.z, value.w]
		TYPE_COLOR:
			return [value.r, value.g, value.b, value.a]
		TYPE_ARRAY:
			var items: Array = []
			for item in value:
				if not variant_type_name(item) in ["Nil", "bool", "int", "float", "String", "Array", "Dictionary"]:
					return null
				var encoded: Variant = encode_value(item)
				if encoded == null and item != null:
					return null
				items.append(encoded)
			return items
		TYPE_DICTIONARY:
			var items: Dictionary = {}
			for key in value:
				if typeof(key) != TYPE_STRING:
					return null
				var item: Variant = value[key]
				if not variant_type_name(item) in ["Nil", "bool", "int", "float", "String", "Array", "Dictionary"]:
					return null
				var encoded: Variant = encode_value(item)
				if encoded == null and item != null:
					return null
				items[key] = encoded
			return items
	return null

func decode_value(item: Dictionary) -> Variant:
	var value: Variant = item.value
	match item.type:
		"bool": return value
		"int": return int(value)
		"float": return float(value)
		"String": return value
		"StringName": return StringName(value)
		"NodePath": return NodePath(value)
		"Vector2": return Vector2(value[0], value[1])
		"Vector2i": return Vector2i(value[0], value[1])
		"Vector3": return Vector3(value[0], value[1], value[2])
		"Vector3i": return Vector3i(value[0], value[1], value[2])
		"Vector4": return Vector4(value[0], value[1], value[2], value[3])
		"Vector4i": return Vector4i(value[0], value[1], value[2], value[3])
		"Color":
			return Color(value[0], value[1], value[2], value[3] if value.size() == 4 else 1.0)
		"Array", "Dictionary": return value
	return null

func owns_resource(value: Variant, target_path: String) -> bool:
	if value is Resource:
		var resource := value as Resource
		var id := resource.get_instance_id()
		if resource.resource_path == target_path:
			return true
		if visited_resources.has(id):
			return false
		visited_resources[id] = true
		for property in resource.get_property_list():
			if (int(property.usage) & PROPERTY_USAGE_STORAGE) != 0:
				if owns_resource(resource.get(property.name), target_path):
					return true
	elif value is Array:
		for item in value:
			if owns_resource(item, target_path):
				return true
	elif value is Dictionary:
		for item in value.values():
			if owns_resource(item, target_path):
				return true
	return false

func find_embedded_resource(scene: PackedScene, source_path: String, subresource_id: String) -> Resource:
	var target_path := source_path + "::" + subresource_id
	var candidate := ResourceLoader.load(target_path, "", ResourceLoader.CACHE_MODE_REUSE) as Resource
	if candidate == null or candidate.resource_path != target_path:
		return null
	var state := scene.get_state()
	visited_resources.clear()
	for node_index in state.get_node_count():
		for property_index in state.get_node_property_count(node_index):
			if owns_resource(state.get_node_property_value(node_index, property_index), target_path):
				return candidate
	return null

func load_target(request: Dictionary) -> Dictionary:
	if request.ownership == "external_shared":
		var resource := ResourceLoader.load(request.sourcePath, "", ResourceLoader.CACHE_MODE_IGNORE) as Resource
		if resource == null or resource is PackedScene:
			return {"error": "Could not load the .tres file as a Resource."}
		return {"owner": resource, "target": resource}
	if request.ownership == "embedded":
		var scene := ResourceLoader.load(request.sourcePath, "", ResourceLoader.CACHE_MODE_REUSE) as PackedScene
		if scene == null:
			return {"error": "Could not load the .tscn file as a PackedScene."}
		var embedded := find_embedded_resource(scene, request.sourcePath, request.subresourceId)
		if embedded == null:
			return {"error": "The selected subresource ID is not an embedded resource owned by this scene."}
		return {"owner": scene, "target": embedded}
	return {"error": "Unsupported resource ownership."}

func reload_target(request: Dictionary) -> Dictionary:
	if request.ownership == "external_shared":
		var resource := ResourceLoader.load(request.stagedPath, "", ResourceLoader.CACHE_MODE_IGNORE) as Resource
		if resource == null or resource is PackedScene:
			return {"error": "Could not reload the staged .tres file."}
		return {"owner": resource, "target": resource}
	var scene := ResourceLoader.load(request.stagedPath, "", ResourceLoader.CACHE_MODE_REUSE) as PackedScene
	if scene == null:
		return {"error": "Could not reload the staged .tscn file."}
	var embedded := find_embedded_resource(scene, request.stagedPath, request.subresourceId)
	if embedded == null:
		return {"error": "The staged scene no longer contains the selected embedded subresource."}
	return {"owner": scene, "target": embedded}

func fail_property(message: String) -> void:
	finish({"error": message}, 1)

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1:
		fail_property("Expected one JSON request.")
		return
	var request: Variant = JSON.parse_string(args[0])
	if not request is Dictionary:
		fail_property("Could not parse the resource-edit request.")
		return
	if not request.has_all(["ownership", "sourcePath", "stagedPath", "stagedFilePath", "changes"]):
		fail_property("The resource-edit request is incomplete.")
		return
	var loaded := load_target(request)
	if loaded.has("error"):
		fail_property(loaded.error)
		return
	var owner: Resource = loaded.owner
	var target: Resource = loaded.target
	var changes: Array = []
	for change in request.changes:
		var property_name: String = change.property
		var property_info: Dictionary = {}
		for candidate in target.get_property_list():
			if str(candidate.name) == property_name:
				property_info = candidate
				break
		if property_info.is_empty() or (int(property_info.usage) & PROPERTY_USAGE_STORAGE) == 0:
			fail_property("Property is missing or is not serializable storage: " + property_name)
			return
		var old_value: Variant = target.get(property_name)
		var old_type := variant_type_name(old_value)
		var new_value: Variant = decode_value(change.value)
		var new_type := variant_type_name(new_value)
		if old_type == "" or new_type == "" or old_type != new_type:
			fail_property("Property %s has unsupported or mismatched type (%s to %s)." % [property_name, old_type, new_type])
			return
		var old_encoded: Variant = encode_value(old_value)
		var new_encoded: Variant = encode_value(new_value)
		if old_encoded == null and old_value != null or new_encoded == null and new_value != null:
			fail_property("Property %s contains a value that this tool cannot safely serialize." % property_name)
			return
		target.set(property_name, new_value)
		var assigned: Variant = target.get(property_name)
		if variant_type_name(assigned) != new_type or assigned != new_value:
			fail_property("Godot rejected the value for property " + property_name)
			return
		changes.append({
			"property": property_name,
			"before": {"type": old_type, "value": old_encoded},
			"after": {"type": new_type, "value": new_encoded},
		})
	var save_error := ResourceSaver.save(owner, request.stagedPath)
	if save_error != OK:
		fail_property("Could not serialize the staged resource (Error %d)." % save_error)
		return
	var reloaded := reload_target(request)
	if reloaded.has("error"):
		fail_property(reloaded.error)
		return
	var verified: Resource = reloaded.target
	for change in request.changes:
		var expected: Variant = decode_value(change.value)
		var actual: Variant = verified.get(change.property)
		if variant_type_name(actual) != variant_type_name(expected) or actual != expected:
			fail_property("The staged serialization did not preserve property " + str(change.property))
			return
	finish({"changes": changes, "validated": true})

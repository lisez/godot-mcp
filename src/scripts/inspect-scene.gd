extends SceneTree

const MARKER := "GODOT_MCP_INSPECT_SCENE="

var external_resources: Dictionary = {}
var embedded_resources: Dictionary = {}
var inspected_scene_path: String

func encode_value(value: Variant) -> Dictionary:
	var type_name := type_string(typeof(value))
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return {"type": type_name, "value": value}
		TYPE_STRING_NAME:
			return {"type": type_name, "value": str(value)}
		TYPE_NODE_PATH:
			return {"type": type_name, "value": str(value)}
		TYPE_VECTOR2:
			return {"type": type_name, "value": [value.x, value.y]}
		TYPE_VECTOR2I:
			return {"type": type_name, "value": [value.x, value.y]}
		TYPE_VECTOR3:
			return {"type": type_name, "value": [value.x, value.y, value.z]}
		TYPE_VECTOR3I:
			return {"type": type_name, "value": [value.x, value.y, value.z]}
		TYPE_VECTOR4:
			return {"type": type_name, "value": [value.x, value.y, value.z, value.w]}
		TYPE_VECTOR4I:
			return {"type": type_name, "value": [value.x, value.y, value.z, value.w]}
		TYPE_RECT2:
			return {"type": type_name, "value": {"position": encode_value(value.position), "size": encode_value(value.size)}}
		TYPE_RECT2I:
			return {"type": type_name, "value": {"position": encode_value(value.position), "size": encode_value(value.size)}}
		TYPE_PLANE:
			return {"type": type_name, "value": [value.normal.x, value.normal.y, value.normal.z, value.d]}
		TYPE_QUATERNION:
			return {"type": type_name, "value": [value.x, value.y, value.z, value.w]}
		TYPE_AABB:
			return {"type": type_name, "value": {"position": encode_value(value.position), "size": encode_value(value.size)}}
		TYPE_BASIS:
			return {"type": type_name, "value": [encode_value(value.x), encode_value(value.y), encode_value(value.z)]}
		TYPE_TRANSFORM2D:
			return {"type": type_name, "value": [encode_value(value.x), encode_value(value.y), encode_value(value.origin)]}
		TYPE_TRANSFORM3D:
			return {"type": type_name, "value": {"basis": encode_value(value.basis), "origin": encode_value(value.origin)}}
		TYPE_PROJECTION:
			return {"type": type_name, "value": [encode_value(value.x), encode_value(value.y), encode_value(value.z), encode_value(value.w)]}
		TYPE_COLOR:
			return {"type": type_name, "value": [value.r, value.g, value.b, value.a]}
		TYPE_ARRAY:
			var items: Array = []
			for item in value:
				items.append(encode_value(item))
			return {"type": type_name, "value": items}
		TYPE_DICTIONARY:
			var entries: Array = []
			for key in value:
				entries.append({"key": encode_value(key), "value": encode_value(value[key])})
			return {"type": type_name, "value": entries}
		TYPE_OBJECT:
			var resource := value as Resource
			if resource == null:
				return {"type": type_name, "available": false, "reason": "Non-resource Object values are not serializable as JSON."}
			var path := resource.resource_path
			var separator := path.find("::")
			var backing_path := path.substr(0, separator) if separator >= 0 else path
			var embedded := separator >= 0 and backing_path == inspected_scene_path
			var external := path.begins_with("res://") and backing_path != inspected_scene_path
			var item := {
				"type": resource.get_class(),
				"path": path,
				"external": external,
				"embedded": embedded,
			}
			if external:
				external_resources[path] = {"path": path, "class": resource.get_class()}
			elif embedded:
				embedded_resources[path] = {"path": path, "class": resource.get_class()}
			return item
		TYPE_RID:
			return {"type": type_name, "available": false, "reason": "RID values are not serializable."}
		_:
			return {"type": type_name, "available": false, "reason": "Unsupported Godot Variant type."}

func inspect(scene_path: String) -> Dictionary:
	inspected_scene_path = scene_path
	var packed := ResourceLoader.load(scene_path, "PackedScene") as PackedScene
	if packed == null:
		return {"error": "Could not load scene: " + scene_path}
	var state := packed.get_state()
	var nodes: Array = []
	for index in range(state.get_node_count()):
		var instance := state.get_node_instance(index)
		var source := "serialized"
		var source_scene: Variant = null
		var placeholder_path: String = state.get_node_instance_placeholder(index)
		if instance != null:
			source = "instanced"
			source_scene = instance.resource_path
		elif not placeholder_path.is_empty():
			source = "instance_placeholder"
			source_scene = placeholder_path
		var properties: Array = []
		var script_source: Variant = null
		for property_index in range(state.get_node_property_count(index)):
			var property_name := str(state.get_node_property_name(index, property_index))
			var property_value: Variant = state.get_node_property_value(index, property_index)
			if property_name == "script":
				script_source = encode_value(property_value)
			properties.append({
				"name": property_name,
				"type": type_string(typeof(property_value)),
				"value": encode_value(property_value),
				"provenance": "stored_override" if source != "serialized" else "stored",
			})
		nodes.append({
			"path": str(state.get_node_path(index)),
			"name": str(state.get_node_name(index)),
			"type": str(state.get_node_type(index)),
			"ownerPath": str(state.get_node_owner_path(index)),
			"groups": Array(state.get_node_groups(index)),
			"source": source,
			"sourceScene": source_scene,
			"script": script_source,
			"properties": properties,
			"defaultProperties": {"available": false, "reason": "PackedSceneState exposes stored properties, not all runtime defaults."},
		})
	var connections: Array = []
	for index in range(state.get_connection_count()):
		connections.append({
			"source": str(state.get_connection_source(index)),
			"signal": str(state.get_connection_signal(index)),
			"target": str(state.get_connection_target(index)),
			"method": str(state.get_connection_method(index)),
			"flags": state.get_connection_flags(index),
			"binds": encode_value(state.get_connection_binds(index)),
		})
	return {
		"scenePath": scene_path,
		"inspection": "file_local_serialized_state",
		"runtimeSnapshot": false,
		"nodes": nodes,
		"connections": connections,
		"externalResources": external_resources.values(),
		"embeddedResources": embedded_resources.values(),
	}

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		print(MARKER + JSON.stringify({"error": "Missing inspection request."}))
		quit(1)
		return
	var request: Variant = JSON.parse_string(Marshalls.base64_to_raw(args[0]).get_string_from_utf8())
	if not request is Dictionary or typeof(request.get("scenePath", null)) != TYPE_STRING:
		print(MARKER + JSON.stringify({"error": "Invalid inspection request."}))
		quit(1)
		return
	var report := inspect(request.scenePath)
	print(MARKER + JSON.stringify(report))
	quit(1 if report.has("error") else 0)

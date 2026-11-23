extends SceneTree

const MARKER := "GODOT_MCP_EDIT_SCENE="

var shared_resources: Dictionary = {}
var embedded_resources: Dictionary = {}
var changes: Array = []
var scene_resource_path: String

func encode_value(value: Variant) -> Dictionary:
	var type_name := type_string(typeof(value))
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return {"type": type_name, "value": value}
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return {"type": type_name, "value": str(value)}
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return {"type": type_name, "value": [value.x, value.y]}
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return {"type": type_name, "value": [value.x, value.y, value.z]}
		TYPE_VECTOR4, TYPE_VECTOR4I:
			return {"type": type_name, "value": [value.x, value.y, value.z, value.w]}
		TYPE_RECT2, TYPE_RECT2I, TYPE_AABB:
			return {"type": type_name, "value": {"position": encode_value(value.position), "size": encode_value(value.size)}}
		TYPE_PLANE:
			return {"type": type_name, "value": [value.normal.x, value.normal.y, value.normal.z, value.d]}
		TYPE_QUATERNION:
			return {"type": type_name, "value": [value.x, value.y, value.z, value.w]}
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
			var values: Array = []
			for item in value:
				var encoded := encode_value(item)
				if not encoded.get("available", true):
					return encoded
				values.append(encoded)
			return {"type": type_name, "value": values}
		TYPE_DICTIONARY:
			var entries: Array = []
			for key in value:
				var encoded_key := encode_value(key)
				var encoded_value := encode_value(value[key])
				if not encoded_key.get("available", true) or not encoded_value.get("available", true):
					return {"type": type_name, "available": false, "reason": "Dictionary contains a value that cannot be serialized."}
				entries.append({"key": encoded_key, "value": encoded_value})
			return {"type": type_name, "value": entries}
		TYPE_OBJECT:
			var resource := value as Resource
			if resource == null:
				return {"type": type_name, "available": false, "reason": "Non-resource Object values are unsupported."}
			return {"type": resource.get_class(), "path": resource.resource_path}
		TYPE_RID:
			return {"type": type_name, "available": false, "reason": "RID values are unsupported."}
		_:
			return {"type": type_name, "available": false, "reason": "Unsupported Godot Variant type."}

func invalid_value(reason: String) -> Dictionary:
	return {"__invalid_scene_edit_value": reason}

func contains_invalid_value(value: Variant) -> bool:
	if value is Dictionary:
		if value.has("__invalid_scene_edit_value"):
			return true
		for key in value:
			if contains_invalid_value(key) or contains_invalid_value(value[key]):
				return true
	elif value is Array:
		for item in value:
			if contains_invalid_value(item):
				return true
	return false

func numeric_components(value: Variant, count: int, integer: bool = false) -> bool:
	if not value is Array or value.size() != count:
		return false
	for component in value:
		if typeof(component) != TYPE_INT and typeof(component) != TYPE_FLOAT:
			return false
		if not is_finite(float(component)) or (integer and float(component) != floor(float(component))):
			return false
	return true

func decode_value(value: Variant) -> Variant:
	if not value is Dictionary or not value.has("type"):
		if value is Array:
			var items: Array = []
			for item in value:
				items.append(decode_value(item))
			return items
		if value is Dictionary:
			var dictionary: Dictionary = {}
			for key in value:
				dictionary[key] = decode_value(value[key])
			return dictionary
		return value
	if value.has("path"):
		var resource_path := str(value.path)
		if not resource_path.begins_with("res://"):
			return invalid_value("resource paths must be project-relative")
		var resource := ResourceLoader.load(resource_path) as Resource
		if resource == null:
			return invalid_value("resource could not be loaded")
		var expected_class := str(value.type)
		if expected_class != "Resource" and not resource.is_class(expected_class):
			return invalid_value("resource class does not match the typed value")
		return resource
	var data: Variant = value.get("value")
	var vector: Array = data if data is Array else []
	var kind := str(value.type)
	var expected_count := 0
	var integer_components := false
	match kind:
		"Vector2", "Vector2i": expected_count = 2
		"Vector3", "Vector3i": expected_count = 3
		"Vector4", "Vector4i", "Color", "Plane", "Quaternion": expected_count = 4
	if expected_count > 0:
		integer_components = kind.ends_with("i")
		if not numeric_components(data, expected_count, integer_components):
			return invalid_value("Malformed numeric components for " + kind)
	match str(value.type):
		"Vector2": return Vector2(vector[0], vector[1])
		"Vector2i": return Vector2i(vector[0], vector[1])
		"Vector3": return Vector3(vector[0], vector[1], vector[2])
		"Vector3i": return Vector3i(vector[0], vector[1], vector[2])
		"Vector4": return Vector4(vector[0], vector[1], vector[2], vector[3])
		"Vector4i": return Vector4i(vector[0], vector[1], vector[2], vector[3])
		"Color": return Color(vector[0], vector[1], vector[2], vector[3])
		"NodePath": return NodePath(data) if data is String else invalid_value("Malformed NodePath")
		"StringName": return StringName(data) if data is String else invalid_value("Malformed StringName")
		"Rect2", "Rect2i", "AABB":
			if not data is Dictionary or not data.has("position") or not data.has("size"):
				return invalid_value("Malformed " + kind)
			var position: Variant = decode_value(data.position)
			var size: Variant = decode_value(data.size)
			if kind == "Rect2" and position is Vector2 and size is Vector2:
				return Rect2(position, size)
			if kind == "Rect2i" and position is Vector2i and size is Vector2i:
				return Rect2i(position, size)
			if kind == "AABB" and position is Vector3 and size is Vector3:
				return AABB(position, size)
			return invalid_value("Malformed components for " + kind)
		"Plane": return Plane(Vector3(vector[0], vector[1], vector[2]), vector[3])
		"Quaternion": return Quaternion(vector[0], vector[1], vector[2], vector[3])
		"Basis":
			if vector.size() == 3:
				var x: Variant = decode_value(vector[0])
				var y: Variant = decode_value(vector[1])
				var z: Variant = decode_value(vector[2])
				if x is Vector3 and y is Vector3 and z is Vector3:
					return Basis(x, y, z)
			return invalid_value("Malformed Basis")
		"Transform2D":
			if vector.size() == 3:
				var x: Variant = decode_value(vector[0])
				var y: Variant = decode_value(vector[1])
				var origin: Variant = decode_value(vector[2])
				if x is Vector2 and y is Vector2 and origin is Vector2:
					return Transform2D(x, y, origin)
			return invalid_value("Malformed Transform2D")
		"Transform3D":
			if data is Dictionary and data.has("basis") and data.has("origin"):
				var basis: Variant = decode_value(data.basis)
				var origin: Variant = decode_value(data.origin)
				if basis is Basis and origin is Vector3:
					return Transform3D(basis, origin)
			return invalid_value("Malformed Transform3D")
		"Projection":
			if vector.size() == 4:
				var x: Variant = decode_value(vector[0])
				var y: Variant = decode_value(vector[1])
				var z: Variant = decode_value(vector[2])
				var w: Variant = decode_value(vector[3])
				if x is Vector4 and y is Vector4 and z is Vector4 and w is Vector4:
					return Projection(x, y, z, w)
			return invalid_value("Malformed Projection")
		"Array":
			if not data is Array:
				return invalid_value("Malformed Array")
			var items: Array = []
			for item in vector:
				items.append(decode_value(item))
			return items
		"Dictionary":
			if not data is Array:
				return invalid_value("Malformed Dictionary")
			var dictionary: Dictionary = {}
			for item in vector:
				if not item is Dictionary or not item.has("key") or not item.has("value"):
					return invalid_value("Malformed Dictionary entry")
				var key: Variant = decode_value(item.key)
				var item_value: Variant = decode_value(item.value)
				if contains_invalid_value(key) or contains_invalid_value(item_value):
					return invalid_value("Malformed Dictionary entry value")
				dictionary[key] = item_value
			return dictionary
		_:
			return invalid_value(str(value.type))

func node_for(root: Node, path: String) -> Node:
	return root if path == "." else root.get_node_or_null(NodePath(path))

func is_external_instance(node: Node, target_scene: String) -> bool:
	return node != null and not node.scene_file_path.is_empty() and node.scene_file_path != target_scene

func require_owned_node(node: Node, root: Node, target_scene: String, path: String) -> String:
	if node == null:
		return "No node exists at path: " + path
	if is_external_instance(node, target_scene):
		return "Editing nodes inside an instanced subscene is unsupported: " + path
	if node != root and node.owner != root:
		return "Node is not owned by the edited scene: " + path
	return ""

func find_property(node: Node, property_name: String) -> Dictionary:
	for property in node.get_property_list():
		if str(property.name) == property_name:
			return property
	return {}

func record_shared_resources(root: Node) -> void:
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		for property in node.get_property_list():
			if (int(property.usage) & PROPERTY_USAGE_STORAGE) == 0:
				continue
			collect_shared_resources(node.get(str(property.name)))
		for child in node.get_children():
			pending.append(child)

func collect_shared_resources(value: Variant) -> void:
	if value is Resource:
		var resource: Resource = value
		var resource_path := resource.resource_path
		var separator := resource_path.find("::")
		var backing_path := resource_path.substr(0, separator) if separator >= 0 else resource_path
		if separator >= 0 and backing_path == scene_resource_path:
			embedded_resources[resource_path] = {"path": resource_path, "class": resource.get_class()}
		elif resource_path.begins_with("res://") and backing_path != scene_resource_path:
			shared_resources[resource_path] = {"path": resource_path, "class": resource.get_class()}
	elif value is Array:
		for item in value:
			collect_shared_resources(item)
	elif value is Dictionary:
		for item in value.values():
			collect_shared_resources(item)

func inside_instance(path: String, instance_paths: Array[String]) -> bool:
	var normalized_path := path.trim_prefix("./")
	for instance_path in instance_paths:
		var normalized_instance := instance_path.trim_prefix("./")
		if normalized_path == normalized_instance or normalized_path.begins_with(normalized_instance + "/"):
			return true
	return false

func snapshot_instances(state: SceneState, instance_paths: Array[String]) -> Dictionary:
	var nodes := {}
	var connections: Array = []
	for index in range(state.get_node_count()):
		var path := str(state.get_node_path(index))
		if not inside_instance(path, instance_paths):
			continue
		var properties := {}
		for property_index in range(state.get_node_property_count(index)):
			var encoded := encode_value(state.get_node_property_value(index, property_index))
			if not encoded.get("available", true):
				return {"error": "Cannot safely preserve an unsupported property value in instanced subscene: " + path}
			properties[str(state.get_node_property_name(index, property_index))] = encoded
		var instance := state.get_node_instance(index)
		nodes[path] = {
			"name": str(state.get_node_name(index)),
			"type": str(state.get_node_type(index)),
			"ownerPath": str(state.get_node_owner_path(index)),
			"index": state.get_node_index(index),
			"groups": Array(state.get_node_groups(index)),
			"instance": instance.resource_path if instance != null else null,
			"placeholder": state.get_node_instance_placeholder(index),
			"properties": properties,
		}
	for index in range(state.get_connection_count()):
		var source := str(state.get_connection_source(index))
		var target := str(state.get_connection_target(index))
		if not inside_instance(source, instance_paths) and not inside_instance(target, instance_paths):
			continue
		var binds := encode_value(state.get_connection_binds(index))
		if not binds.get("available", true):
			return {"error": "Cannot safely preserve unsupported signal binds on an instanced subscene."}
		connections.append({
			"source": source,
			"target": target,
			"signal": str(state.get_connection_signal(index)),
			"method": str(state.get_connection_method(index)),
			"flags": state.get_connection_flags(index),
			"unbinds": state.get_connection_unbinds(index) if state.has_method("get_connection_unbinds") else 0,
			"binds": binds,
		})
	return {"nodes": nodes, "connections": connections}

func apply_operation(root: Node, operation: Dictionary, target_scene: String) -> String:
	var kind := str(operation.type)
	if kind == "create_node":
		var parent_path := str(operation.parentPath)
		var parent := node_for(root, parent_path)
		var problem := require_owned_node(parent, root, target_scene, parent_path)
		if not problem.is_empty():
			return problem
		var name := str(operation.name)
		if name == "." or name == ".." or parent.has_node(NodePath(name)):
			return "Parent already has a child named " + name + "."
		var class_id := str(operation.nodeType)
		if not ClassDB.class_exists(class_id) or not ClassDB.is_parent_class(class_id, "Node"):
			return "nodeType must be an instantiable built-in Node class: " + class_id
		var object: Object = ClassDB.instantiate(class_id)
		var child: Node = object as Node
		if child == null:
			return "Could not instantiate Node class: " + class_id
		child.name = name
		parent.add_child(child)
		child.owner = root
		changes.append({"operation": kind, "nodePath": name if parent_path == "." else parent_path + "/" + name, "after": {"name": name, "type": child.get_class()}})
		return ""
	if kind == "instantiate_scene":
		var parent_path := str(operation.parentPath)
		var parent := node_for(root, parent_path)
		var problem := require_owned_node(parent, root, target_scene, parent_path)
		if not problem.is_empty():
			return problem
		var name := str(operation.name)
		if name == "." or name == ".." or parent.has_node(NodePath(name)):
			return "Parent already has a child named " + name + "."
		var instance_path := str(operation.scenePath)
		var packed := ResourceLoader.load(instance_path, "PackedScene") as PackedScene
		if packed == null:
			return "Could not load scene to instantiate: " + instance_path
		var child := packed.instantiate()
		if child == null:
			return "Could not instantiate scene: " + instance_path
		child.name = name
		parent.add_child(child)
		child.owner = root
		changes.append({"operation": kind, "nodePath": name if parent_path == "." else parent_path + "/" + name, "after": {"scenePath": instance_path}})
		return ""
	if kind == "set_property":
		var path := str(operation.nodePath)
		var node := node_for(root, path)
		var problem := require_owned_node(node, root, target_scene, path)
		if not problem.is_empty():
			return problem
		var property_name := str(operation.property)
		var property := find_property(node, property_name)
		if property.is_empty() or (int(property.usage) & PROPERTY_USAGE_STORAGE) == 0:
			return "Property is missing or not serializable on " + path + ": " + property_name
		var decoded: Variant = decode_value(operation.value)
		if contains_invalid_value(decoded):
			return "Unsupported or malformed typed value for property " + property_name + "."
		var expected_type := int(property.type)
		if expected_type != TYPE_NIL and typeof(decoded) != expected_type:
			if expected_type == TYPE_FLOAT and typeof(decoded) == TYPE_INT:
				decoded = float(decoded)
			else:
				return "Property type mismatch for " + property_name + ": expected " + type_string(expected_type) + ", received " + type_string(typeof(decoded)) + "."
		if expected_type == TYPE_OBJECT and decoded is Resource and not str(property.class_name).is_empty():
			if not decoded.is_class(str(property.class_name)):
				return "Resource class mismatch for property " + property_name + "."
		var old_value: Variant = node.get(property_name)
		var old_encoded := encode_value(old_value)
		if not old_encoded.get("available", true):
			return "Existing property value cannot be serialized safely: " + property_name
		node.set(property_name, decoded)
		var read_back: Variant = node.get(property_name)
		if typeof(read_back) != typeof(decoded) or read_back != decoded:
			node.set(property_name, old_value)
			return "Godot did not accept the requested value exactly for property " + property_name + "."
		var new_encoded := encode_value(read_back)
		if not new_encoded.get("available", true):
			node.set(property_name, old_value)
			return "New property value cannot be serialized safely: " + property_name
		changes.append({"operation": kind, "nodePath": path, "property": property_name, "before": old_encoded, "after": new_encoded})
		return ""
	if kind == "connect_signal":
		var source_path := str(operation.sourcePath)
		var target_path := str(operation.targetPath)
		var source := node_for(root, source_path)
		var target := node_for(root, target_path)
		var problem := require_owned_node(source, root, target_scene, source_path)
		if problem.is_empty():
			problem = require_owned_node(target, root, target_scene, target_path)
		if not problem.is_empty():
			return problem
		var signal_name := StringName(str(operation.signal))
		var method_name := StringName(str(operation.method))
		var signal_info: Dictionary = {}
		for item in source.get_signal_list():
			if StringName(item.name) == signal_name:
				signal_info = item
				break
		if signal_info.is_empty():
			return "Signal does not exist on " + source_path + ": " + str(signal_name)
		var method_info: Dictionary = {}
		for item in target.get_method_list():
			if StringName(item.name) == method_name:
				method_info = item
				break
		if method_info.is_empty():
			return "Signal target has no such method: " + target_path + "." + str(method_name)
		var flags := int(operation.get("flags", CONNECT_PERSIST))
		var allowed_flags := CONNECT_PERSIST | CONNECT_DEFERRED | CONNECT_ONE_SHOT | CONNECT_REFERENCE_COUNTED
		if (flags & CONNECT_PERSIST) == 0 or (flags & ~allowed_flags) != 0:
			return "Signal flags must include CONNECT_PERSIST and contain only supported connection flags."
		var binds: Array = operation.get("binds", [])
		var decoded_binds: Array = []
		for bind in binds:
			var decoded: Variant = decode_value(bind)
			if contains_invalid_value(decoded):
				return "Signal binds contain an unsupported or malformed typed value."
			decoded_binds.append(decoded)
		var method_arguments: Array = method_info.get("args", [])
		var minimum_arguments: int = method_arguments.size() - method_info.get("default_args", []).size()
		var signal_arguments: Array = signal_info.get("args", [])
		var provided_arguments: int = signal_arguments.size() + decoded_binds.size()
		if provided_arguments < minimum_arguments or provided_arguments > method_arguments.size():
			return "Signal argument and bind count is incompatible with target method " + str(method_name) + "."
		var callable := Callable(target, method_name).bindv(decoded_binds)
		if source.is_connected(signal_name, callable):
			return "Signal connection already exists."
		var error := source.connect(signal_name, callable, flags)
		if error != OK:
			return "Could not connect signal: " + str(error)
		changes.append({
			"operation": kind,
			"sourcePath": source_path,
			"signal": str(signal_name),
			"targetPath": target_path,
			"method": str(method_name),
			"flags": flags,
			"binds": encode_value(decoded_binds),
		})
		return ""
	return "Unsupported edit operation: " + kind

func finish(report: Dictionary) -> void:
	print(MARKER + JSON.stringify(report))
	quit(1 if report.has("error") else 0)

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		finish({"error": "Missing edit request."})
		return
	var request: Variant = JSON.parse_string(Marshalls.base64_to_raw(args[0]).get_string_from_utf8())
	if not request is Dictionary:
		finish({"error": "Invalid edit request."})
		return
	scene_resource_path = str(request.get("scenePath", ""))
	var packed := ResourceLoader.load(scene_resource_path, "PackedScene") as PackedScene
	if packed == null:
		finish({"error": "Could not load scene: " + scene_resource_path})
		return
	var state := packed.get_state()
	if state.get_node_count() > 0 and state.get_node_instance(0) != null:
		finish({"error": "Editing inherited scenes is unsupported; no changes were staged."})
		return
	var instance_paths: Array[String] = []
	for index in range(1, state.get_node_count()):
		if state.get_node_instance(index) != null or not state.get_node_instance_placeholder(index).is_empty():
			instance_paths.append(str(state.get_node_path(index)))
	var original_instances := snapshot_instances(state, instance_paths)
	if original_instances.has("error"):
		finish(original_instances)
		return
	var root := packed.instantiate()
	if root == null:
		finish({"error": "Could not instantiate scene: " + scene_resource_path})
		return
	var editable_instances := {}
	for path in instance_paths:
		var instance_node := node_for(root, path)
		if instance_node != null:
			editable_instances[path] = root.is_editable_instance(instance_node)
	for operation in request.get("operations", []):
		var problem := apply_operation(root, operation, scene_resource_path)
		if not problem.is_empty():
			root.free()
			finish({"error": problem, "changes": changes})
			return
	record_shared_resources(root)
	var edited := PackedScene.new()
	var pack_error := edited.pack(root)
	root.free()
	if pack_error != OK:
		finish({"error": "Could not pack the edited scene: " + str(pack_error), "changes": changes})
		return
	var stage_path := str(request.get("stagePath", ""))
	if not stage_path.begins_with("res://") or not stage_path.ends_with(".tscn"):
		finish({"error": "Invalid same-project staging path.", "changes": changes})
		return
	var save_error := ResourceSaver.save(edited, stage_path)
	if save_error != OK:
		finish({"error": "Could not serialize staged scene: " + str(save_error), "changes": changes})
		return
	var verification := ResourceLoader.load(stage_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) as PackedScene
	if verification == null:
		finish({"error": "Staged scene could not be reloaded; original scene was not changed.", "changes": changes})
		return
	var staged_instances := snapshot_instances(verification.get_state(), instance_paths)
	if staged_instances.has("error"):
		finish(staged_instances)
		return
	if JSON.stringify(original_instances) != JSON.stringify(staged_instances):
		finish({"error": "Cannot safely preserve existing instanced subscenes and their serialized overrides; original scene was not changed.", "changes": changes})
		return
	if not editable_instances.is_empty():
		var reloaded_root := verification.instantiate()
		if reloaded_root == null:
			finish({"error": "Cannot safely verify editable instanced subscenes after reload.", "changes": changes})
			return
		for path in editable_instances:
			var reloaded_node := node_for(reloaded_root, path)
			if reloaded_node == null or reloaded_root.is_editable_instance(reloaded_node) != editable_instances[path]:
				reloaded_root.free()
				finish({"error": "Cannot safely preserve editable state of instanced subscenes; original scene was not changed.", "changes": changes})
				return
		reloaded_root.free()
	var report := {
		"changes": changes,
		"sharedExternalResources": shared_resources.values(),
		"embeddedResources": embedded_resources.values(),
		"stagedSceneReloaded": true,
	}
	finish(report)

extends SceneTree

var schedule: Dictionary
var output_dir: String
var events: Array
var captures: Array
var assertions: Array
var results: Array[Dictionary] = []
var assertion_results: Array[Dictionary] = []
var fingers: Dictionary = {}
var mouse_buttons: Dictionary = {}
var mouse_positions: Dictionary = {}
var frame := -1
var last_frame := 0
var event_index := 0
var capture_index := 0
var physics_pending := false
var finished := false
var screenshot_pending := false

func _initialize() -> void:
	var request := OS.get_cmdline_user_args()[0]
	output_dir = request.get_base_dir()
	schedule = JSON.parse_string(FileAccess.get_file_as_string(request))
	seed(int(schedule.seed))
	events = schedule.events
	captures = schedule.captures
	assertions = schedule.get("assertions", [])
	if not events.is_empty():
		last_frame = int(events.back().frame)
	if not captures.is_empty():
		last_frame = maxi(last_frame, int(captures.back().frame))
	if not assertions.is_empty():
		last_frame = maxi(last_frame, int(assertions.back().frame))
	# Permit a render/idle update after each physics tick, including on slow hosts.
	Engine.max_physics_steps_per_frame = 1
	start_scene.call_deferred()

func start_scene() -> void:
	var packed := load(schedule.scenePath) as PackedScene
	if packed == null:
		fail("Could not load scene: " + str(schedule.scenePath))
		return
	var scene := packed.instantiate()
	if scene == null:
		fail("Could not instantiate scene: " + str(schedule.scenePath))
		return
	root.add_child(scene)
	current_scene = scene
	physics_frame.connect(begin_frame)
	process_frame.connect(after_physics)

func begin_frame() -> void:
	if finished or screenshot_pending:
		return
	frame += 1
	physics_pending = true
	while event_index < events.size() and int(events[event_index].frame) == frame:
		var item: Dictionary = events[event_index]
		if ["press", "drag", "release"].has(item.type):
			send_touch(item)
		else:
			send_input(item)
		event_index += 1

func send_touch(item: Dictionary) -> void:
	var id := int(item.fingerId)
	var pos := Vector2(item.x, item.y)
	var event: InputEvent
	if item.type == "drag":
		var drag := InputEventScreenDrag.new()
		drag.index = id
		drag.position = pos
		drag.relative = pos - Vector2(fingers[id])
		event = drag
	else:
		var touch := InputEventScreenTouch.new()
		touch.index = id
		touch.position = pos
		touch.pressed = item.type == "press"
		event = touch
	if item.type == "release":
		fingers.erase(id)
	else:
		fingers[id] = pos
	# Input.parse_input_event expects window pixels; Godot converts back to viewport coordinates.
	send_positional_event(event)

func send_input(item: Dictionary) -> void:
	var device := int(item.get("device", 0))
	var event: InputEvent
	match item.type:
		"key":
			var key := InputEventKey.new()
			key.device = device
			key.keycode = int(item.keycode)
			key.pressed = bool(item.pressed)
			event = key
		"mouse_button":
			var button := InputEventMouseButton.new()
			var index := int(item.buttonIndex)
			var current_mask := int(mouse_buttons.get(device, 0))
			if index < 4 or index > 7:
				var mask := 1 << (index - 1)
				current_mask = current_mask | mask if item.pressed else current_mask & ~mask
			mouse_buttons[device] = current_mask
			button.device = device
			button.button_index = index
			button.pressed = bool(item.pressed)
			button.position = Vector2(item.x, item.y)
			button.button_mask = current_mask
			mouse_positions[device] = button.position
			event = button
		"mouse_motion":
			var motion := InputEventMouseMotion.new()
			var position := Vector2(item.x, item.y)
			motion.device = device
			motion.position = position
			motion.relative = position - Vector2(mouse_positions.get(device, position))
			motion.button_mask = int(mouse_buttons.get(device, 0))
			mouse_positions[device] = position
			event = motion
		"joypad_button":
			var button := InputEventJoypadButton.new()
			button.device = device
			button.button_index = int(item.buttonIndex)
			button.pressed = bool(item.pressed)
			event = button
		"joypad_axis":
			var axis := InputEventJoypadMotion.new()
			axis.device = device
			axis.axis = int(item.axis)
			axis.axis_value = float(item.value)
			event = axis
	if event is InputEventMouse:
		send_positional_event(event)
	else:
		Input.parse_input_event(event)
		Input.flush_buffered_events()

func send_positional_event(event: InputEvent) -> void:
	Input.parse_input_event(event.xformed_by(root.get_final_transform()))
	Input.flush_buffered_events()

func after_physics() -> void:
	if finished or screenshot_pending or not physics_pending:
		return
	physics_pending = false
	var screenshot := false
	if capture_index < captures.size() and int(captures[capture_index].frame) == frame:
		var capture: Dictionary = captures[capture_index]
		capture_index += 1
		var positions := {}
		for path in capture.get("nodePaths", []):
			var node := current_scene.get_node_or_null(NodePath(path)) if current_scene != null else null
			if node is Node3D:
				var position: Vector3 = node.global_position
				positions[path] = [position.x, position.y, position.z]
			elif node is Node2D or node is Control:
				var position: Vector2 = node.global_position
				positions[path] = [position.x, position.y]
			else:
				fail("Expected a positioned node at %s on frame %d." % [path, frame])
				return
		results.append({"frame": frame, "positions": positions})
		screenshot = capture.get("screenshot", false)
	while assertion_results.size() < assertions.size() and int(assertions[assertion_results.size()].frame) == frame:
		assertion_results.append(evaluate_assertion(assertions[assertion_results.size()]))
	if screenshot:
		if DisplayServer.get_name() == "headless":
			fail("Screenshot capture requires a rendering display.")
			return
		# Freeze all project nodes, including PROCESS_MODE_ALWAYS, until this draw completes.
		screenshot_pending = true
		var previous_pause := paused
		var modes: Array = []
		for child in root.get_children():
			freeze_node(child, modes)
		paused = true
		await RenderingServer.frame_post_draw
		var image := root.get_texture().get_image()
		for entry in modes:
			var node: Node = entry[0].get_ref()
			if node != null:
				node.process_mode = entry[1]
		paused = previous_pause
		screenshot_pending = false
		if image == null or image.is_empty():
			fail("Renderer could not read the viewport at frame %d." % frame)
			return
		var png := output_dir.path_join("frame-%d.png" % frame)
		if image.save_png(png) != OK:
			fail("Could not save screenshot for frame %d." % frame)
			return
	if frame == last_frame:
		finished = true
		var report := FileAccess.open(output_dir.path_join("result.json"), FileAccess.WRITE)
		if report == null:
			fail("Could not write the replay report.")
			return
		report.store_string(JSON.stringify({"captures": results, "assertions": assertion_results}))
		report.close()
		quit(0)

func freeze_node(node: Node, modes: Array) -> void:
	modes.append([weakref(node), node.process_mode])
	node.process_mode = Node.PROCESS_MODE_DISABLED
	for child in node.get_children():
		freeze_node(child, modes)

func evaluate_assertion(assertion: Dictionary) -> Dictionary:
	var result := {
		"frame": frame,
		"nodePath": assertion.nodePath,
		"property": assertion.property,
		"operator": assertion.operator,
		"expected": assertion.expected,
		"actual": null,
		"passed": false,
	}
	var node := current_scene.get_node_or_null(NodePath(assertion.nodePath)) if current_scene != null else null
	if node == null:
		result.error = "Node path was not found."
		return result
	var property_found := false
	for property in node.get_property_list():
		if String(property.name) == assertion.property:
			property_found = true
			break
	if not property_found:
		result.error = "Property was not found on the target node."
		return result
	var normalized := normalize_value(node.get(assertion.property))
	if not normalized.supported:
		result.error = "Property type is not supported for assertions."
		return result
	result.actual = normalized.value
	var comparison := compare_values(assertion, result.actual)
	if not comparison.valid:
		result.error = comparison.error
		return result
	result.passed = comparison.passed
	return result

func normalize_value(value: Variant) -> Dictionary:
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return {"supported": true, "value": value}
		TYPE_STRING_NAME:
			return {"supported": true, "value": str(value)}
		TYPE_VECTOR2:
			return {"supported": true, "value": [value.x, value.y]}
		TYPE_VECTOR2I:
			return {"supported": true, "value": [value.x, value.y]}
		TYPE_VECTOR3:
			return {"supported": true, "value": [value.x, value.y, value.z]}
		TYPE_VECTOR3I:
			return {"supported": true, "value": [value.x, value.y, value.z]}
	return {"supported": false}

func compare_values(assertion: Dictionary, actual: Variant) -> Dictionary:
	var expected: Variant = assertion.expected
	var operator: String = assertion.operator
	if operator == "equals" or operator == "not_equals":
		var actual_type := typeof(actual)
		var expected_type := typeof(expected)
		var actual_numeric := actual_type == TYPE_INT or actual_type == TYPE_FLOAT
		var expected_numeric := expected_type == TYPE_INT or expected_type == TYPE_FLOAT
		if not (actual_numeric and expected_numeric) and actual_type != expected_type:
			return {"valid": false, "error": "Actual and expected values have incompatible types."}
		if actual is Array and actual.size() != expected.size():
			return {"valid": false, "error": "Actual and expected vectors have incompatible dimensions."}
	if operator == "equals":
		return {"valid": true, "passed": actual == expected}
	if operator == "not_equals":
		return {"valid": true, "passed": actual != expected}
	if operator == "approximately":
		var tolerance := float(assertion.tolerance)
		if (typeof(actual) == TYPE_FLOAT or typeof(actual) == TYPE_INT) and \
				(typeof(expected) == TYPE_FLOAT or typeof(expected) == TYPE_INT):
			return {"valid": true, "passed": abs(float(actual) - float(expected)) <= tolerance}
		if actual is Array and expected is Array and actual.size() == expected.size():
			for index in actual.size():
				if abs(float(actual[index]) - float(expected[index])) > tolerance:
					return {"valid": true, "passed": false}
			return {"valid": true, "passed": true}
		return {"valid": false, "error": "approximately requires matching numeric or vector values."}
	if typeof(actual) != TYPE_FLOAT and typeof(actual) != TYPE_INT:
		return {"valid": false, "error": "Ordered comparisons require a numeric property value."}
	var actual_number := float(actual)
	var expected_number := float(expected)
	match operator:
		"greater_than":
			return {"valid": true, "passed": actual_number > expected_number}
		"greater_than_or_equal":
			return {"valid": true, "passed": actual_number >= expected_number}
		"less_than":
			return {"valid": true, "passed": actual_number < expected_number}
		"less_than_or_equal":
			return {"valid": true, "passed": actual_number <= expected_number}
	return {"valid": false, "error": "Unsupported comparison operator."}

func fail(message: String) -> void:
	finished = true
	printerr(message)
	quit(1)

extends SceneTree

var schedule: Dictionary
var output_dir: String
var events: Array
var captures: Array
var results: Array[Dictionary] = []
var fingers: Dictionary = {}
var frame := -1
var last_frame := 0
var event_index := 0
var capture_index := 0
var physics_pending := false
var finished := false

func _initialize() -> void:
	var request := OS.get_cmdline_user_args()[0]
	output_dir = request.get_base_dir()
	schedule = JSON.parse_string(FileAccess.get_file_as_string(request))
	seed(int(schedule.seed))
	events = schedule.events
	captures = schedule.captures
	if not events.is_empty():
		last_frame = int(events.back().frame)
	if not captures.is_empty():
		last_frame = maxi(last_frame, int(captures.back().frame))
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
	if finished:
		return
	frame += 1
	physics_pending = true
	while event_index < events.size() and int(events[event_index].frame) == frame:
		send_touch(events[event_index])
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
	Input.parse_input_event(event.xformed_by(root.get_final_transform()))
	Input.flush_buffered_events()

func after_physics() -> void:
	if finished or not physics_pending:
		return
	physics_pending = false
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
		if capture.get("screenshot", false):
			if DisplayServer.get_name() == "headless":
				fail("Screenshot capture requires a rendering display.")
				return
			await RenderingServer.frame_post_draw
			var image := root.get_texture().get_image()
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
		report.store_string(JSON.stringify(results))
		report.close()
		quit(0)

func fail(message: String) -> void:
	finished = true
	printerr(message)
	quit(1)

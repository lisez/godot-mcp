extends SceneTree

const MARKER := "GODOT_MCP_PREVIEW_SCENE="

var finished := false
var target_frame := 1
var frame_index := -1
var request: Dictionary

func finish(report: Dictionary) -> void:
	if finished:
		return
	finished = true
	print(MARKER + JSON.stringify(report))
	quit(1 if report.has("error") else 0)

func start_preview() -> void:
	if DisplayServer.get_name() == "headless":
		finish({"error": "A graphical display and rendering backend are required; this host is headless."})
		return
	var scene_path := str(request.get("scenePath", ""))
	var packed := ResourceLoader.load(scene_path, "PackedScene") as PackedScene
	if packed == null:
		finish({"error": "Could not load preview scene: " + scene_path})
		return
	var scene := packed.instantiate()
	if scene == null:
		finish({"error": "Could not instantiate preview scene: " + scene_path})
		return
	root.size = Vector2i(int(request.width), int(request.height))
	DisplayServer.window_set_size(Vector2i(int(request.width), int(request.height)))
	Engine.max_physics_steps_per_frame = 1
	root.add_child(scene)
	current_scene = scene
	target_frame = maxi(0, int(request.get("captureFrame", 1)))
	capture_when_ready.call_deferred()

func capture_when_ready() -> void:
	while frame_index < target_frame:
		await physics_frame
		await process_frame
		if finished:
			return
		frame_index += 1
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	if image == null or image.is_empty():
		finish({"error": "Renderer could not read the root viewport."})
		return
	if image.get_width() != int(request.width) or image.get_height() != int(request.height):
		finish({
			"error": "Rendered viewport dimensions do not match the requested dimensions.",
			"width": image.get_width(),
			"height": image.get_height(),
		})
		return
	var pixel_hash_context := HashingContext.new()
	pixel_hash_context.start(HashingContext.HASH_SHA256)
	pixel_hash_context.update(image.get_data())
	var pixel_hash := pixel_hash_context.finish().hex_encode()
	finish({
		"png": Marshalls.raw_to_base64(image.save_png_to_buffer()),
		"width": image.get_width(),
		"height": image.get_height(),
		"captureFrame": frame_index,
		"pixelHash": pixel_hash,
	})

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		finish({"error": "Missing preview request."})
		return
	var decoded := Marshalls.base64_to_raw(args[0]).get_string_from_utf8()
	var parsed: Variant = JSON.parse_string(decoded)
	if not parsed is Dictionary:
		finish({"error": "Invalid preview request."})
		return
	request = parsed
	if request.get("seed") != null:
		seed(int(request.seed))
	start_preview.call_deferred()

extends SceneTree

var nodes: Array = []
var origins: Dictionary = {}
var root_inverse := Transform3D.IDENTITY

func vector(value: Vector3) -> Array:
	return [value.x, value.y, value.z]

func transform_data(value: Transform3D) -> Dictionary:
	return {
		"origin": vector(value.origin), "basis": {
			"x": vector(value.basis.x), "y": vector(value.basis.y), "z": vector(value.basis.z)
		}
	}

# Traverse the packed scene off-tree to inspect the authored pose before _ready or animation.
func visit(node: Node, path: String, parent_path: Variant, parent_global: Transform3D) -> void:
	var item := {"name": str(node.name), "type": node.get_class(), "path": path, "parent": parent_path}
	var spatial := node as Node3D
	var world := Transform3D.IDENTITY
	if spatial != null:
		world = spatial.transform if spatial.top_level else parent_global * spatial.transform
		if spatial.is_scale_disabled():
			world.basis = world.basis.orthonormalized()
		var model := root_inverse * world
		item["localTransform"] = transform_data(spatial.transform)
		item["modelTransform"] = transform_data(model)
		origins[path] = model.origin
	nodes.append(item)
	for child in node.get_children():
		var child_path := str(child.name) if path == "." else path + "/" + str(child.name)
		visit(child, child_path, path, world)

func finish(report: Dictionary) -> void:
	print("GODOT_MCP_MODEL=" + JSON.stringify(report))
	quit(1 if report.has("error") else 0)

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var packed := ResourceLoader.load(args[0], "PackedScene") as PackedScene
	if packed == null:
		finish({"error": "Could not load %s. Import the project and check scene dependencies." % args[0]})
		return
	var instance := packed.instantiate()
	if instance == null:
		finish({"error": "Could not instantiate " + args[0]})
		return
	var spatial := instance as Node3D
	if spatial != null:
		var root_transform := spatial.transform
		if spatial.is_scale_disabled():
			root_transform.basis = root_transform.basis.orthonormalized()
		if root_transform.basis.determinant() == 0.0:
			instance.free()
			finish({"error": "The model root has a singular transform; model-root coordinates are undefined."})
			return
		root_inverse = root_transform.affine_inverse()
	visit(instance, ".", null, Transform3D.IDENTITY)
	instance.free()
	var report := {"modelPath": args[0], "nodes": nodes}
	if args.size() == 3:
		for path in [args[1], args[2]]:
			if not origins.has(path):
				finish({"error": "No Node3D at model-relative path: " + path})
				return
		var displacement: Vector3 = origins[args[2]] - origins[args[1]]
		report["measurement"] = {
			"fromNode": args[1], "toNode": args[2], "displacement": vector(displacement),
			"distance": displacement.length(),
			"direction": null if displacement == Vector3.ZERO else vector(displacement.normalized())
		}
	finish(report)

extends SceneTree

var debug_mode = false

func _init():
    var args = OS.get_cmdline_args()
    debug_mode = "--debug-godot" in args
    var script_index = args.find("--script")
    if script_index == -1:
        log_error("Could not find --script argument")
        quit(1)
        return

    var params_index = script_index + 2
    if args.size() <= params_index:
        log_error("Usage: godot --headless --script <operation-script.gd> <json_params>")
        log_error("Not enough command-line arguments provided.")
        quit(1)
        return

    log_debug("All arguments: " + str(args))
    log_debug("Script index: " + str(script_index))
    log_debug("Params index: " + str(params_index))
    var operation = operation_name()
    var params_json = args[params_index]
    log_info("Operation: " + operation)
    log_debug("Params JSON: " + params_json)

    var json = JSON.new()
    var error = json.parse(params_json)
    if error != OK:
        log_error("Failed to parse JSON parameters: " + params_json)
        log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
        quit(1)
        return
    var params = json.get_data()
    if not params:
        log_error("Failed to parse JSON parameters: " + params_json)
        quit(1)
        return

    log_info("Executing operation: " + operation)
    run_operation(params)
    quit()

func operation_name():
    return ""

func run_operation(_params):
    log_error("Operation is not implemented")
    quit(1)

func log_debug(message):
    if debug_mode:
        print("[DEBUG] " + message)

func log_info(message):
    print("[INFO] " + message)

func log_error(message):
    printerr("[ERROR] " + message)

# Get a script by registered class name.
# Only looks up names via the project's global class registry. Raw paths
# (e.g. "res://evil.gd") are intentionally not accepted here to prevent
# arbitrary script instantiation from agent-supplied input.

func get_script_by_name(name_of_class):
    if debug_mode:
        print("Attempting to get script for class: " + name_of_class)

    # Search for it in the global class registry if it's a class name
    var global_classes = ProjectSettings.get_global_class_list()
    if debug_mode:
        print("Searching through " + str(global_classes.size()) + " global classes")

    for global_class in global_classes:
        var found_name_of_class = global_class["class"]
        var found_path = global_class["path"]

        if found_name_of_class == name_of_class:
            if debug_mode:
                print("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script = load(found_path) as Script
            if script:
                if debug_mode:
                    print("Successfully loaded script from registry")
                return script
            else:
                printerr("Failed to load script from registry path: " + found_path)
                break

    printerr("Could not find script for class: " + name_of_class)
    return null

# Instantiate a class by name

func instantiate_class(name_of_class):
    if name_of_class.is_empty():
        printerr("Cannot instantiate class: name is empty")
        return null

    var result = null
    if debug_mode:
        print("Attempting to instantiate class: " + name_of_class)

    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            print("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            print("Class not found in ClassDB, trying to get script")
        var script = get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                print("Found GDScript, creating instance")
            result = script.new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null

    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        print("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())

    return result


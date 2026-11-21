import fs from 'node:fs';
import path from 'path';

// Make the build/index.js file executable
fs.chmodSync(path.join(import.meta.dirname, '..', 'build', 'index.js'), '755');

// Copy the scripts directory to the build directory
try {
  // Ensure the build/scripts directory exists
  fs.mkdirSync(path.join(import.meta.dirname, '..', 'build', 'scripts'), { recursive: true });
  
  // Copy the godot_operations.gd file
  fs.copyFileSync(
    path.join(import.meta.dirname, '..', 'src', 'scripts', 'godot_operations.gd'),
    path.join(import.meta.dirname, '..', 'build', 'scripts', 'godot_operations.gd')
  );
  
  console.log('Successfully copied godot_operations.gd to build/scripts');
} catch (error) {
  console.error('Error copying scripts:', error);
  process.exit(1);
}

console.log('Build scripts completed successfully!');

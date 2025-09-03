#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';

function runCommand(command, description) {
  console.log(`${description}...`);
  try {
    execSync(command, { stdio: 'inherit', cwd: process.cwd() });
  } catch (error) {
    console.error(`Error running: ${command}`);
    process.exit(1);
  }
}

// Update the importmap
runCommand('node bin/generate-importmap.js', 'Updating the importmap');

// Compile the app icons
runCommand('python bin/compile-sl-icons.py', 'Compiling the app icons');

// Bundle templates
runCommand('node bin/bundle-templates.js', 'Bundling templates');

// Bundle application
const rollupPath = path.join('node_modules', '.bin', 'rollup');
runCommand(`"${rollupPath}" app/src/app.js -f es -o app/web/app.js -p @rollup/plugin-node-resolve`, 'Bundling application');
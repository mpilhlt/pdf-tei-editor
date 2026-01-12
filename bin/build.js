#!/usr/bin/env node

/**
 * PDF TEI Editor Build Script
 *
 * Usage:
 *   node bin/build.js                    # Run all steps
 *   node bin/build.js --steps=step1,step2  # Run specific steps
 *   node bin/build.js --skip=step1,step2   # Skip specific steps
 *
 * Available steps:
 *   - importmap: Update the importmap
 *   - icons: Compile the app icons
 *   - templates: Bundle templates
 *   - version: Generate version.js from package.json
 *   - pdfjs: Copy PDF.js files for production
 *   - highlight: Bundle highlight.js for syntax highlighting
 *   - bundle: Bundle application with Rollup
 */

import { execSync } from 'child_process';
import path from 'path';

/**
 * @param {string} command
 * @param {string} description
 */
function runCommand(command, description) {
  console.log(`${description}...`);
  try {
    execSync(command, { stdio: 'inherit', cwd: process.cwd() });
  } catch (error) {
    console.error(`Error running: ${command}`);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
let stepsToRun = new Set(['importmap', 'icons', 'templates', 'version', 'pdfjs', 'highlight', 'bundle']);
let stepsToSkip = new Set();

args.forEach(arg => {
  if (arg.startsWith('--steps=')) {
    const requestedSteps = arg.split('=')[1].split(',');
    stepsToRun = new Set(requestedSteps);
  } else if (arg.startsWith('--skip=')) {
    const skipSteps = arg.split('=')[1].split(',');
    stepsToSkip = new Set(skipSteps);
  }
});

// Remove skipped steps
stepsToSkip.forEach(step => stepsToRun.delete(step));

console.log(`[INFO] Running build steps: ${Array.from(stepsToRun).join(', ')}`);
if (stepsToSkip.size > 0) {
  console.log(`[INFO] Skipping steps: ${Array.from(stepsToSkip).join(', ')}`);
}

// Define build steps
/** @type {Record<string, () => void>} */
const buildSteps = {
  importmap: () => runCommand('node bin/generate-importmap.js', 'Updating the importmap'),
  icons: () => runCommand('uv run python bin/compile-sl-icons.py', 'Compiling the app icons'),
  templates: () => runCommand('node bin/bundle-templates.js', 'Bundling templates'),
  version: () => runCommand('node bin/generate-version.js', 'Generating version file'),
  pdfjs: () => runCommand('node bin/copy-pdfjs.js', 'Copying PDF.js files for production'),
  highlight: () => {
    const rollupPath = path.join('node_modules', '.bin', 'rollup');
    runCommand(`"${rollupPath}" -c rollup.config.highlight.js`, 'Bundling highlight.js');
  },
  bundle: () => {
    const rollupPath = path.join('node_modules', '.bin', 'rollup');
    runCommand(`"${rollupPath}" -c rollup.config.js`, 'Bundling application');
  }
};

// Execute selected steps in order
const stepOrder = ['importmap', 'icons', 'templates', 'version', 'pdfjs', 'highlight', 'bundle'];
stepOrder.forEach(step => {
  if (stepsToRun.has(step) && buildSteps[step]) {
    buildSteps[step]();
  }
});
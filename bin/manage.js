#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

// Get all command line arguments after 'node manage.js'
const args = process.argv.slice(2);

// Spawn the Python manage.py script with uv
const child = spawn('uv', ['run', 'python', join(projectRoot, 'bin', 'manage.py'), ...args], {
    stdio: 'inherit',
    cwd: projectRoot
});

child.on('error', (error) => {
    console.error('Error running manage.py:', error.message);
    process.exit(1);
});

child.on('exit', (code) => {
    process.exit(code || 0);
});
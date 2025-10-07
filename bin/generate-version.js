#!/usr/bin/env node

/**
 * Generates app/web/version.js from package.json version
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Read package.json
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const version = packageJson.version || '0.0.0';

// Generate version.js content
const content = `// Auto-generated file - do not edit manually
// This file is created during the build process from package.json
export const version = '${version}';
`;

// Write to app/web/version.js
const outputPath = join(rootDir, 'app', 'web', 'version.js');
writeFileSync(outputPath, content, 'utf-8');

console.log(`Generated version.js with version ${version}`);

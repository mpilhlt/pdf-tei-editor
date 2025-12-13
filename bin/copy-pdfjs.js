#!/usr/bin/env node

/**
 * Copy PDF.js files from node_modules to app/web/pdfjs for production builds
 *
 * This script copies the necessary PDF.js library files from the pdfjs-dist
 * npm package to the web directory so they can be served in production without
 * shipping the entire node_modules folder.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const sourceDir = path.join(rootDir, 'node_modules', 'pdfjs-dist');
const targetDir = path.join(rootDir, 'app', 'web', 'pdfjs');

// Files to copy from pdfjs-dist
const filesToCopy = [
  { src: 'build/pdf.mjs', dest: 'build/pdf.mjs' },
  { src: 'build/pdf.mjs.map', dest: 'build/pdf.mjs.map' },
  { src: 'build/pdf.worker.mjs', dest: 'build/pdf.worker.mjs' },
  { src: 'build/pdf.worker.mjs.map', dest: 'build/pdf.worker.mjs.map' },
  { src: 'web/pdf_viewer.mjs', dest: 'web/pdf_viewer.mjs' },
  { src: 'web/pdf_viewer.mjs.map', dest: 'web/pdf_viewer.mjs.map' },
  { src: 'web/pdf_viewer.css', dest: 'web/pdf_viewer.css' },
  { src: 'LICENSE', dest: 'LICENSE' }
];

// Directories to copy recursively
const dirsToCopy = [
  { src: 'web/images', dest: 'web/images' }
];

/**
 * Ensure directory exists
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Copy a file
 * @param {string} src
 * @param {string} dest
 */
function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  ensureDir(destDir);
  fs.copyFileSync(src, dest);
  console.log(`  ✓ ${path.relative(rootDir, dest)}`);
}

/**
 * Copy a directory recursively
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  ensureDir(dest);

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ✓ ${path.relative(rootDir, destPath)}`);
    }
  }
}

// Check if source directory exists
if (!fs.existsSync(sourceDir)) {
  console.error('Error: pdfjs-dist not found in node_modules');
  console.error('Run "npm install" first');
  process.exit(1);
}

console.log('Copying PDF.js files from pdfjs-dist...');

// Copy files
filesToCopy.forEach(({ src, dest }) => {
  const srcPath = path.join(sourceDir, src);
  const destPath = path.join(targetDir, dest);

  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠ Source file not found: ${src}`);
    return;
  }

  copyFile(srcPath, destPath);
});

// Copy directories
dirsToCopy.forEach(({ src, dest }) => {
  const srcPath = path.join(sourceDir, src);
  const destPath = path.join(targetDir, dest);

  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠ Source directory not found: ${src}`);
    return;
  }

  copyDir(srcPath, destPath);
});

console.log(`PDF.js files copied to ${path.relative(rootDir, targetDir)}`);

#!/usr/bin/env node

/**
 * Template Bundling Script
 * 
 * This script statically analyzes JavaScript files to find registerTemplate() calls
 * and generates a templates.json file with template ID -> HTML content mappings.
 * This allows templates to be bundled for production while maintaining dynamic
 * loading in development mode.
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Recursively finds all JavaScript files in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} extensions - File extensions to include
 * @returns {Promise<string[]>} Array of file paths
 */
async function findJavaScriptFiles(dir, extensions = ['.js', '.mjs']) {
  const files = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip node_modules and other build directories
        if (!['node_modules', 'web', '.git'].includes(entry.name)) {
          files.push(...await findJavaScriptFiles(fullPath, extensions));
        }
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dir}:`, error.message);
  }
  
  return files;
}

/**
 * Parses a JavaScript file to find registerTemplate() calls
 * @param {string} filePath - Path to the JavaScript file
 * @returns {Promise<Array>} Array of {id, pathOrHtml} objects
 */
async function parseTemplateRegistrations(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    const registrations = [];
    
    // Regular expression to match registerTemplate calls
    // Matches: registerTemplate('id', 'path') or registerTemplate("id", "path")
    const registerPattern = /registerTemplate\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/g;
    
    let match;
    while ((match = registerPattern.exec(content)) !== null) {
      const [, id, pathOrHtml] = match;
      registrations.push({ id, pathOrHtml, sourceFile: filePath });
    }
    
    return registrations;
  } catch (error) {
    console.warn(`Warning: Could not parse file ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Resolves a template path to its full file system path
 * @param {string} templatePath - Template path from registerTemplate call
 * @param {string} appSrcDir - Base app/src directory
 * @returns {string} Resolved file path
 */
function resolveTemplatePath(templatePath, appSrcDir) {  
  // If it's an absolute path starting with /, resolve relative to app/src
  if (templatePath.startsWith('/')) {
    return join(appSrcDir, templatePath.substring(1));
  }
  
  // Otherwise, assume it's relative to templates directory
  return join(appSrcDir, 'templates', templatePath);
}

/**
 * Loads HTML content from a template file
 * @param {string} filePath - Path to the template file
 * @returns {Promise<string>} HTML content
 */
async function loadTemplateFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.trim();
  } catch (error) {
    throw new Error(`Failed to load template file '${filePath}': ${error.message}`);
  }
}

/**
 * Main function to analyze templates and generate templates.json
 */
export async function main() {
  console.log('🔍 Analyzing template registrations...');
  
  const projectRoot = resolve(__dirname, '..');
  const appSrcDir = join(projectRoot, 'app', 'src');
  const outputPath = join(projectRoot, 'app', 'web', 'templates.json');
  
  // Find all JavaScript files
  const jsFiles = await findJavaScriptFiles(appSrcDir);
  console.log(`Found ${jsFiles.length} JavaScript files to analyze`);
  
  // Parse all template registrations
  const allRegistrations = [];
  for (const file of jsFiles) {
    const registrations = await parseTemplateRegistrations(file);
    allRegistrations.push(...registrations);
  }
  
  console.log(`Found ${allRegistrations.length} template registrations`);
  
  // Build templates object
  const templates = {};
  const errors = [];
  
  for (const registration of allRegistrations) {
    const { id, pathOrHtml, sourceFile } = registration;
    
    try {
      let html;
      
      if (pathOrHtml.trim().startsWith('<')) {
        // Literal HTML
        html = pathOrHtml.trim();
        console.log(`  ✓ ${id}: literal HTML (${html.length} chars)`);
      } else {
        // Template file
        const templatePath = resolveTemplatePath(pathOrHtml, appSrcDir);
        html = await loadTemplateFile(templatePath);
        console.log(`  ✓ ${id}: ${relative(projectRoot, templatePath)} (${html.length} chars)`);
      }
      
      // Check for duplicate IDs
      if (templates[id]) {
        console.warn(`  ⚠️  Warning: Template ID '${id}' is already registered, overwriting`);
      }
      
      templates[id] = html;
      
    } catch (error) {
      const errorMsg = `Failed to process template '${id}' from ${relative(projectRoot, sourceFile)}: ${error.message}`;
      errors.push(errorMsg);
      console.error(`  ❌ ${errorMsg}`);
    }
  }
  
  // Create output directory if it doesn't exist
  const outputDir = dirname(outputPath);
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create output directory:', error.message);
    process.exit(1);
  }
  
  // Write templates.json
  try {
    const jsonContent = JSON.stringify(templates, null, 2);
    await writeFile(outputPath, jsonContent, 'utf8');
    console.log(`\n📦 Generated templates.json with ${Object.keys(templates).length} templates`);
    console.log(`   Output: ${relative(projectRoot, outputPath)}`);
    
    if (errors.length > 0) {
      console.error(`\n❌ ${errors.length} error(s) occurred:`);
      errors.forEach(error => console.error(`   ${error}`));
      process.exit(1);
    }
    
  } catch (error) {
    console.error('Failed to write templates.json:', error.message);
    process.exit(1);
  }
}

// Run the script if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
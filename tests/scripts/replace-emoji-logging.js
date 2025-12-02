#!/usr/bin/env node

/**
 * Replace emoji-based logging with TestLogger
 *
 * This script systematically replaces console.log/error statements with emojis
 * with standardized TestLogger calls for better parseable output.
 */

import { readFile, writeFile } from 'fs/promises';
import { glob } from 'glob';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

/**
 * Emoji to logger method mappings
 * Handles emojis anywhere in the message (start, middle, or with indentation)
 */
const emojiMappings = [
  // Success/OK markers - at start with optional indentation
  { pattern: /console\.log\(`([ \t]*)✅\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.success('$2')" },
  { pattern: /console\.log\('([ \t]*)✅\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.success('$2')" },
  { pattern: /console\.log\(`([ \t]*)✓\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.success('$2')" },
  { pattern: /console\.log\('([ \t]*)✓\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.success('$2')" },

  // Error markers - can be at start or middle of message
  { pattern: /console\.log\('([ \t]*)❌\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.error('$2')" },
  { pattern: /console\.log\(`([ \t]*)❌\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.error('$2')" },
  { pattern: /console\.log\('(.+?)\s+❌\s+(.+?)'\)/g, replacement: "logger.error('$1 $2')" },
  { pattern: /console\.log\(`(.+?)\s+❌\s+(.+?)`\)/g, replacement: "logger.error('$1 $2')" },
  { pattern: /console\.error\(`([ \t]*)❌\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.error('$2')" },
  { pattern: /console\.error\('([ \t]*)❌\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.error('$2')" },

  // Warning markers - can be at start or middle
  { pattern: /console\.log\('([ \t]*)⚠️\s+(.+?)',\s*(.+?)\)/g, replacement: "console.log('$1'); logger.warn(`$2: ${$3}`)" },
  { pattern: /console\.log\(`([ \t]*)⚠️\s+(.+?)`,\s*(.+?)\)/g, replacement: "console.log('$1'); logger.warn(`$2: ${$3}`)" },
  { pattern: /console\.log\('([ \t]*)⚠️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.warn('$2')" },
  { pattern: /console\.log\(`([ \t]*)⚠️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.warn('$2')" },
  { pattern: /console\.log\('(.+?)\s*⚠️\s*(.+?)'\)/g, replacement: "logger.warn('$1 $2')" },
  { pattern: /console\.log\(`(.+?)\s*⚠️\s*(.+?)`\)/g, replacement: "logger.warn('$1 $2')" },
  { pattern: /console\.log\('([ \t]*)⚠\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.warn('$2')" },
  { pattern: /console\.log\(`([ \t]*)⚠\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.warn('$2')" },
  { pattern: /console\.error\(`([ \t]*)⚠️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.warn('$2')" },
  { pattern: /console\.error\('([ \t]*)⚠️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.warn('$2')" },

  // Info markers (various emojis used for info)
  { pattern: /console\.log\(`([ \t]*)📦\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)📦\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)📋\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)📋\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)📁\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)📁\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)📥\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)📥\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)ℹ️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)ℹ️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)ℹ\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)ℹ\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🔍\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🔍\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)👁️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)👁️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🏗️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🏗️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)⏭️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)⏭️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🗑️\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🗑️\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)📄\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)📄\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🚀\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🚀\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🆔\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🆔\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🛑\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🛑\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🐙\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🐙\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\(`([ \t]*)🐳\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🐳\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },

  // Data markers
  { pattern: /console\.log\(`([ \t]*)📊\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.data('$2')" },
  { pattern: /console\.log\('([ \t]*)📊\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.data('$2')" },

  // Cleanup marker (treat as info)
  { pattern: /console\.log\(`([ \t]*)🧹\s+(.+?)`\)/g, replacement: "console.log('$1'); logger.info('$2')" },
  { pattern: /console\.log\('([ \t]*)🧹\s+(.+?)'\)/g, replacement: "console.log('$1'); logger.info('$2')" },

  // Clean up empty console.log for indentation (when there's no indentation)
  { pattern: /console\.log\(''\); /g, replacement: "" },
  { pattern: /console\.log\(""\); /g, replacement: "" },
];

/**
 * Check if file needs TestLogger import
 */
function needsLoggerImport(content) {
  return /\blogger\.(info|success|warn|error|debug|data)\(/.test(content) &&
         !/import.*logger.*from.*test-logger/.test(content);
}

/**
 * Add TestLogger import to file
 */
function addLoggerImport(content, filePath) {
  // Determine relative path to test-logger.js
  const relPath = relative(dirname(filePath), join(projectRoot, 'tests/api/helpers')).replace(/\\/g, '/');
  const importPath = relPath ? `${relPath}/test-logger.js` : './test-logger.js';

  // Find the last import statement
  const importRegex = /^import\s+.+?from\s+.+?;$/gm;
  const imports = content.match(importRegex);

  if (imports && imports.length > 0) {
    const lastImport = imports[imports.length - 1];
    const importStatement = `import { logger } from '${importPath}';`;

    // Insert after last import
    return content.replace(lastImport, `${lastImport}\n${importStatement}`);
  } else {
    // No imports found, add at top after shebang/comments
    const lines = content.split('\n');
    let insertIndex = 0;

    // Skip shebang and initial comments
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#!') || line.startsWith('//') || line.startsWith('/*') || line === '') {
        insertIndex = i + 1;
      } else {
        break;
      }
    }

    lines.splice(insertIndex, 0, `import { logger } from '${importPath}';`, '');
    return lines.join('\n');
  }
}

/**
 * Process a single file
 */
async function processFile(filePath) {
  let content = await readFile(filePath, 'utf-8');
  let modified = false;

  // Apply all emoji replacements
  for (const { pattern, replacement } of emojiMappings) {
    const before = content;
    content = content.replace(pattern, replacement);
    if (content !== before) {
      modified = true;
    }
  }

  // Fix template literals: replace single quotes with backticks for strings containing ${
  const templateLiteralPattern = /logger\.(info|success|warn|error|debug|data)\('([^']*\$\{[^']*)'(?:,\s*(.+?))?\)/g;
  const beforeTemplateFix = content;
  content = content.replace(templateLiteralPattern, (match, method, message, args) => {
    if (args) {
      return `logger.${method}(\`${message}\`, ${args})`;
    }
    return `logger.${method}(\`${message}\`)`;
  });
  if (content !== beforeTemplateFix) {
    modified = true;
  }

  // Replace console.log with "==>" prefix to logger.info (handles both strings and template literals)
  const arrowPattern1 = /console\.log\(['"]\\n?==> (.+?)['"]\)/g;
  const arrowPattern2 = /console\.log\(`\\n?==> (.+?)`\)/g;
  const beforeArrowFix = content;
  content = content.replace(arrowPattern1, 'logger.info(\'$1\')');
  content = content.replace(arrowPattern2, 'logger.info(`$1`)');
  if (content !== beforeArrowFix) {
    modified = true;
  }

  // Add import if needed
  if (modified && needsLoggerImport(content)) {
    content = addLoggerImport(content, filePath);
  }

  if (modified) {
    await writeFile(filePath, content, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Main execution
 */
async function main() {
  console.log('[SCRIPT] Replacing emoji-based logging with TestLogger\n');

  // Find all test-related JavaScript files
  const patterns = [
    'tests/**/*.js',
    '!tests/**/node_modules/**',
    '!tests/api/helpers/test-logger.js', // Skip the logger itself
    '!tests/scripts/replace-emoji-logging.js', // Skip this script
  ];

  const files = await glob(patterns, {
    cwd: projectRoot,
    absolute: true,
  });

  console.log(`[INFO] Found ${files.length} files to process\n`);

  let modifiedCount = 0;

  for (const file of files) {
    const wasModified = await processFile(file);
    if (wasModified) {
      console.log(`[OK] ${relative(projectRoot, file)}`);
      modifiedCount++;
    }
  }

  console.log(`\n[INFO] Modified ${modifiedCount} file(s)`);

  if (modifiedCount === 0) {
    console.log('[INFO] No emoji-based logging found to replace');
  }
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});

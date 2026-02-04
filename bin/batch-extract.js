#!/usr/bin/env node

/**
 * Batch extract metadata from PDFs in a directory using the HTTP API.
 *
 * Usage:
 *   node bin/batch-extract.js [options] <path>
 *   node bin/batch-extract.js --extract-only --collection <id> --extractor <id>
 *
 * Options:
 *   --env <path>              Path to .env file (default: ./.env)
 *   --user <username>         Username for authentication (default: from .env API_USER)
 *   --password <password>     Password for authentication (default: from .env API_PASSWORD)
 *   --base-url <url>          API base URL (default: from .env API_BASE_URL or http://localhost:8000)
 *   --collection <id>         Collection ID (default: directory basename, required for --extract-only)
 *   --extractor <id>          Extractor ID (required, can be specified multiple times)
 *   --option <key=value>      Extractor option (can be specified multiple times)
 *   --recursive               Recursively search directories
 *   --extract-only            Extract from existing files in collection (no upload)
 *
 * Arguments:
 *   path                      Directory containing PDF files (required unless --extract-only)
 *
 * Environment variables (from .env file):
 *   API_USER                  Username for authentication
 *   API_PASSWORD              Password for authentication
 *   API_BASE_URL              API base URL
 */

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { glob } from 'glob';
import { createHash } from 'crypto';
import dotenv from 'dotenv';
import { stdout } from 'process';

/**
 * Create a progress bar string
 * @param {number} current - Current progress
 * @param {number} total - Total items
 * @param {number} barLength - Length of the bar
 * @returns {string} - Progress bar string
 */
function createProgressBar(current, total, barLength = 40) {
  const percentage = (current / total) * 100;
  const filled = Math.round((current / total) * barLength);
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
  return `[${bar}] ${current}/${total} (${percentage.toFixed(1)}%)`;
}

/**
 * Update progress bar in place
 * @param {string} message - Progress message
 */
function updateProgress(message) {
  // Only use progress bar if stdout is a TTY (not being redirected/piped)
  if (stdout.isTTY) {
    // Truncate message to terminal width to prevent line wrapping
    const termWidth = stdout.columns || 80;
    const maxLen = termWidth - 1;
    const truncatedMessage = message.length > maxLen
      ? message.slice(0, maxLen - 3) + '...'
      : message.padEnd(maxLen);
    stdout.write(`\r${truncatedMessage}`);
  } else {
    // In non-TTY mode (tests, logs), just print the message
    console.log(message);
  }
}

/**
 * Extract DOI from filename if it contains one
 * @param {string} filename - Filename to parse
 * @returns {string|null} - DOI if found, null otherwise
 */
function extractDOIFromFilename(filename) {
  // Remove file extension
  const stem = filename.replace(/\.(pdf|PDF)$/, '');

  // Decode double-underscore encoding: "10.5771__2699-1284-2024-3-149" → "10.5771/2699-1284-2024-3-149"
  const decoded = stem.replace(/__/g, '/');

  // Check if result looks like a DOI (starts with "10." and has reasonable structure)
  const doiPattern = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
  if (doiPattern.test(decoded)) {
    return decoded;
  }

  return null;
}

/**
 * Hash password using SHA-256 (matching frontend authentication)
 * @param {string} password - Plain text password
 * @returns {string} - Hex hash
 */
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

/**
 * Login to the API and get session ID
 * @param {string} baseUrl - API base URL
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Session ID
 */
async function login(baseUrl, username, password) {
  const passwdHash = hashPassword(password);

  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, passwd_hash: passwdHash }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.sessionId;
}

/**
 * List available extractors
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @returns {Promise<Array<{id: string, name: string, description: string}>>} - List of extractors
 */
async function listExtractors(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/api/v1/extract/list`, {
    method: 'GET',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list extractors: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Validate that all specified extractors exist
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string[]} extractorIds - Extractor IDs to validate
 * @returns {Promise<void>}
 * @throws {Error} If any extractor doesn't exist
 */
async function validateExtractors(baseUrl, sessionId, extractorIds) {
  const availableExtractors = await listExtractors(baseUrl, sessionId);
  const availableIds = new Set(availableExtractors.map(e => e.id));

  const invalidExtractors = extractorIds.filter(id => !availableIds.has(id));

  if (invalidExtractors.length > 0) {
    console.error(`\nUnknown extractor(s): ${invalidExtractors.join(', ')}`);
    console.error('\nAvailable extractors:');
    for (const extractor of availableExtractors) {
      console.error(`  - ${extractor.id}: ${extractor.name}`);
      if (extractor.description) {
        console.error(`    ${extractor.description}`);
      }
    }
    throw new Error(`Invalid extractor ID(s): ${invalidExtractors.join(', ')}`);
  }
}

/**
 * Upload a PDF file
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} filePath - Path to PDF file
 * @returns {Promise<{type: string, filename: string}>} - Upload response
 */
async function uploadFile(baseUrl, sessionId, filePath) {
  const formData = new FormData();

  // Read file and create Blob
  const fileBuffer = await readFile(filePath);
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  const fileName = filePath.split('/').pop();
  formData.append('file', blob, fileName);

  const response = await fetch(`${baseUrl}/api/v1/files/upload`, {
    method: 'POST',
    headers: {
      'X-Session-ID': sessionId,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload failed for ${fileName}: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Extract metadata from uploaded file
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} fileId - File ID (stable_id)
 * @param {string} extractor - Extractor ID
 * @param {Object} options - Extraction options
 * @returns {Promise<{id: string, pdf: string, xml: string}>} - Extraction response
 */
async function extractMetadata(baseUrl, sessionId, fileId, extractor, options) {
  const response = await fetch(`${baseUrl}/api/v1/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({
      extractor,
      file_id: fileId,
      options,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Extraction failed for ${fileId}: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Ensure collection exists, creating it if necessary
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} collectionId - Collection ID
 * @returns {Promise<void>}
 */
async function ensureCollection(baseUrl, sessionId, collectionId) {
  // Try to get collection list
  const listResponse = await fetch(`${baseUrl}/api/v1/collections`, {
    method: 'GET',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  if (!listResponse.ok) {
    throw new Error(`Failed to list collections: ${listResponse.status}`);
  }

  const collections = await listResponse.json();
  const exists = collections.some(c => c.id === collectionId);

  if (exists) {
    console.log(`Collection '${collectionId}' already exists`);
    return;
  }

  // Create the collection
  console.log(`Creating collection '${collectionId}'...`);
  const createResponse = await fetch(`${baseUrl}/api/v1/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({
      id: collectionId,
      name: collectionId,
      description: `Auto-created by batch-extract for ${collectionId}`,
    }),
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`Failed to create collection: ${createResponse.status} ${error}`);
  }

  console.log(`Collection '${collectionId}' created successfully`);
}

/**
 * Get existing files in a collection
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} collectionId - Collection ID
 * @returns {Promise<Set<string>>} - Set of existing filenames
 */
async function getExistingFiles(baseUrl, sessionId, collectionId) {
  const response = await fetch(`${baseUrl}/api/v1/collections/${collectionId}/files`, {
    method: 'GET',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  if (!response.ok) {
    // If collection doesn't exist or no files, return empty set
    if (response.status === 404) {
      return new Set();
    }
    const error = await response.text();
    throw new Error(`Failed to get collection files: ${response.status} ${error}`);
  }

  const data = await response.json();
  const filenames = data.files.map(f => f.filename);
  return new Set(filenames);
}

/**
 * Get all files in a collection with their stable_ids
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} collectionId - Collection ID
 * @returns {Promise<Array<{filename: string, stable_id: string}>>} - List of files
 */
async function getCollectionFiles(baseUrl, sessionId, collectionId) {
  const response = await fetch(`${baseUrl}/api/v1/collections/${collectionId}/files`, {
    method: 'GET',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get collection files: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.files;
}

/**
 * Main batch upload and extract function
 * @param {Object} options - Command options
 */
async function batchUpload(options) {
  const {
    env: envPath,
    user: cliUser,
    password: cliPassword,
    baseUrl: cliBaseUrl,
    collection: collectionArg,
    extractor: extractors,
    option: optionPairs,
    recursive,
    path: dirPath
  } = options;

  // Load environment variables
  const envFile = resolve(envPath);
  const envConfig = dotenv.config({ path: envFile });

  if (envConfig.error && envPath !== './.env') {
    console.error(`Failed to load environment from ${envFile}`);
    throw envConfig.error;
  }

  // Get credentials - CLI args override env vars
  const username = cliUser || process.env.API_USER;
  const password = cliPassword || process.env.API_PASSWORD;
  const baseUrl = cliBaseUrl || process.env.API_BASE_URL || 'http://localhost:8000';

  if (!username || !password) {
    throw new Error('Username and password must be provided via --user/--password or API_USER/API_PASSWORD in .env file');
  }

  // Default collection to directory basename if not provided
  const collection = collectionArg || dirPath.split('/').filter(Boolean).pop();

  // Parse extractor options
  const extractorOptions = { collection };
  if (optionPairs) {
    for (const pair of optionPairs) {
      const [key, value] = pair.split('=');
      if (!key || value === undefined) {
        throw new Error(`Invalid option format: ${pair}. Expected key=value`);
      }
      extractorOptions[key] = value;
    }
  }

  // Find PDF files
  const pattern = recursive ? '**/*.pdf' : '*.pdf';
  const searchPath = join(dirPath, pattern);
  const files = await glob(searchPath, { nodir: true });

  if (files.length === 0) {
    console.log(`No PDF files found in ${dirPath}`);
    return;
  }

  console.log(`Found ${files.length} PDF file(s)`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Collection: ${collection}`);
  console.log(`Extractor(s): ${extractors.join(', ')}`);
  if (Object.keys(extractorOptions).length > 1) {
    console.log(`Options: ${JSON.stringify(extractorOptions, null, 2)}`);
  }

  // Login
  console.log('\nLogging in...');
  const sessionId = await login(baseUrl, username, password);
  console.log('Login successful');

  // Validate extractors exist
  await validateExtractors(baseUrl, sessionId, extractors);

  // Ensure collection exists
  await ensureCollection(baseUrl, sessionId, collection);

  // Get existing files to skip
  console.log('Checking for existing files...');
  const existingFiles = await getExistingFiles(baseUrl, sessionId, collection);

  if (existingFiles.size > 0) {
    console.log(`Found ${existingFiles.size} existing file(s) in collection - will skip`);
  }

  // Filter out files that already exist
  const filesToProcess = files.filter(filePath => {
    const fileName = filePath.split('/').pop();
    return !existingFiles.has(fileName);
  });

  const skippedCount = files.length - filesToProcess.length;

  if (skippedCount > 0) {
    console.log(`Skipping ${skippedCount} file(s) that already exist`);
  }

  if (filesToProcess.length === 0) {
    console.log('\nAll files already processed - nothing to do');
    console.log(`\n=== Summary ===`);
    console.log(`Total: ${files.length}`);
    console.log(`Already processed: ${skippedCount}`);
    console.log(`New: 0`);
    return;
  }

  console.log(`Processing ${filesToProcess.length} new file(s)`);

  // Process each file
  let successCount = 0;
  let failCount = 0;
  let currentFile = 0;

  console.log(''); // Empty line before progress bar

  for (const filePath of filesToProcess) {
    const fileName = filePath.split('/').pop();
    currentFile++;

    try {
      // Show upload progress
      const uploadProgress = createProgressBar(currentFile - 1, filesToProcess.length);
      updateProgress(`${uploadProgress} Uploading: ${fileName}`);

      const uploadResult = await uploadFile(baseUrl, sessionId, filePath);

      // Extract DOI from filename if present
      const doi = extractDOIFromFilename(fileName);
      const fileExtractorOptions = { ...extractorOptions };
      if (doi) {
        fileExtractorOptions.doi = doi;
      }

      // Run extraction for each extractor
      for (const extractor of extractors) {
        const extractProgress = createProgressBar(currentFile - 1, filesToProcess.length);
        updateProgress(`${extractProgress} Extracting (${extractor}): ${fileName}${doi ? ` (DOI: ${doi})` : ''}`);

        await extractMetadata(
          baseUrl,
          sessionId,
          uploadResult.filename,
          extractor,
          fileExtractorOptions
        );
      }

      successCount++;

      // Update progress bar with completion
      const completedProgress = createProgressBar(currentFile, filesToProcess.length);
      updateProgress(`${completedProgress} Completed: ${fileName}`);

    } catch (error) {
      failCount++;
      // Clear progress bar and show error on new line
      if (stdout.isTTY) {
        const termWidth = stdout.columns || 80;
        stdout.write(`\r${' '.repeat(termWidth)}\r`);
      }
      console.log(`❌ Error processing ${fileName}: ${error.message}`);
    }
  }

  // Add final newline after progress bar in TTY mode
  if (stdout.isTTY) {
    console.log('');
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${files.length}`);
  console.log(`Already processed: ${skippedCount}`);
  console.log(`New: ${filesToProcess.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failCount}`);
}

/**
 * Batch extract-only function (no upload, uses existing files in collection)
 * @param {Object} options - Command options
 */
async function batchExtractOnly(options) {
  const {
    env: envPath,
    user: cliUser,
    password: cliPassword,
    baseUrl: cliBaseUrl,
    collection,
    extractor: extractors,
    option: optionPairs,
  } = options;

  if (!collection) {
    throw new Error('--collection is required when using --extract-only');
  }

  // Load environment variables
  const envFile = resolve(envPath);
  const envConfig = dotenv.config({ path: envFile });

  if (envConfig.error && envPath !== './.env') {
    console.error(`Failed to load environment from ${envFile}`);
    throw envConfig.error;
  }

  // Get credentials - CLI args override env vars
  const username = cliUser || process.env.API_USER;
  const password = cliPassword || process.env.API_PASSWORD;
  const baseUrl = cliBaseUrl || process.env.API_BASE_URL || 'http://localhost:8000';

  if (!username || !password) {
    throw new Error('Username and password must be provided via --user/--password or API_USER/API_PASSWORD in .env file');
  }

  // Parse extractor options
  const extractorOptions = { collection };
  if (optionPairs) {
    for (const pair of optionPairs) {
      const [key, value] = pair.split('=');
      if (!key || value === undefined) {
        throw new Error(`Invalid option format: ${pair}. Expected key=value`);
      }
      extractorOptions[key] = value;
    }
  }

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Collection: ${collection}`);
  console.log(`Extractor(s): ${extractors.join(', ')}`);
  console.log(`Mode: extract-only (no upload)`);
  if (Object.keys(extractorOptions).length > 1) {
    console.log(`Options: ${JSON.stringify(extractorOptions, null, 2)}`);
  }

  // Login
  console.log('\nLogging in...');
  const sessionId = await login(baseUrl, username, password);
  console.log('Login successful');

  // Validate extractors exist
  await validateExtractors(baseUrl, sessionId, extractors);

  // Get files from collection
  console.log('Fetching files from collection...');
  const collectionFiles = await getCollectionFiles(baseUrl, sessionId, collection);

  if (collectionFiles.length === 0) {
    console.log(`No files found in collection '${collection}'`);
    return;
  }

  console.log(`Found ${collectionFiles.length} file(s) in collection`);

  // Process each file
  let successCount = 0;
  let failCount = 0;
  let currentFile = 0;

  console.log(''); // Empty line before progress bar

  for (const file of collectionFiles) {
    const { filename, stable_id } = file;
    currentFile++;

    try {
      // Extract DOI from filename if present
      const doi = extractDOIFromFilename(filename);
      const fileExtractorOptions = { ...extractorOptions };
      if (doi) {
        fileExtractorOptions.doi = doi;
      }

      // Run extraction for each extractor
      for (const extractor of extractors) {
        const extractProgress = createProgressBar(currentFile - 1, collectionFiles.length);
        updateProgress(`${extractProgress} Extracting (${extractor}): ${filename}${doi ? ` (DOI: ${doi})` : ''}`);

        await extractMetadata(
          baseUrl,
          sessionId,
          stable_id,
          extractor,
          fileExtractorOptions
        );
      }

      successCount++;

      // Update progress bar with completion
      const completedProgress = createProgressBar(currentFile, collectionFiles.length);
      updateProgress(`${completedProgress} Completed: ${filename}`);

    } catch (error) {
      failCount++;
      // Clear progress bar and show error on new line
      if (stdout.isTTY) {
        const termWidth = stdout.columns || 80;
        stdout.write(`\r${' '.repeat(termWidth)}\r`);
      }
      console.log(`❌ Error processing ${filename}: ${error.message}`);
    }
  }

  // Add final newline after progress bar in TTY mode
  if (stdout.isTTY) {
    console.log('');
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${collectionFiles.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failCount}`);
}

// CLI setup
const program = new Command();

program
  .name('batch-extract')
  .description('Batch extract metadata from PDFs in a directory')
  .addHelpText('after', `
DOI Filename Encoding:
  If PDF filenames contain DOIs, they will be automatically extracted and passed
  to the extractor. Encode DOIs in filenames by replacing "/" with "__" (double underscore).

  Example: "10.5771/2699-1284-2024-3-149.pdf" → "10.5771__2699-1284-2024-3-149.pdf"

Examples:
  # Basic usage (uses directory name as collection)
  $ npm run batch-extract -- /path/to/manuscripts --extractor grobid

  # With multiple extractors (runs each extractor on every file)
  $ npm run batch-extract -- /path/to/pdfs --extractor grobid --extractor llamore-gemini

  # With explicit collection and recursive search
  $ npm run batch-extract -- /path/to/pdfs --collection my_collection --extractor mock-extractor --recursive

  # With DOI-encoded filenames (DOI will be extracted automatically)
  $ npm run batch-extract -- /path/to/pdfs --extractor llamore-gemini
    # Processes: 10.5771__2699-1284-2024-3-149.pdf → DOI: 10.5771/2699-1284-2024-3-149

  # Extract-only mode (re-extract existing files in a collection without re-uploading)
  $ npm run batch-extract -- --extract-only --collection my_collection --extractor grobid
`)
  .showHelpAfterError()
  .argument('[path]', 'Directory containing PDF files (required unless --extract-only)')
  .option('--env <path>', 'Path to .env file', './.env')
  .option('--user <username>', 'Username for authentication (default: from .env API_USER)')
  .option('--password <password>', 'Password for authentication (default: from .env API_PASSWORD)')
  .option('--base-url <url>', 'API base URL (default: from .env API_BASE_URL or http://localhost:8000)')
  .option('--collection <id>', 'Collection ID (default: directory basename, required for --extract-only)')
  .requiredOption('--extractor <id>', 'Extractor ID (can be specified multiple times)', (value, previous) => {
    return previous ? [...previous, value] : [value];
  })
  .option('--option <key=value>', 'Extractor option (repeatable)', (value, previous) => {
    return previous ? [...previous, value] : [value];
  })
  .option('--recursive', 'Recursively search directories', false)
  .option('--extract-only', 'Extract from existing files in collection (no upload)', false)
  .action(async (path, cmdOptions) => {
    try {
      if (cmdOptions.extractOnly) {
        await batchExtractOnly(cmdOptions);
      } else {
        if (!path) {
          throw new Error('<path> argument is required unless --extract-only is specified');
        }
        await batchUpload({ ...cmdOptions, path });
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();

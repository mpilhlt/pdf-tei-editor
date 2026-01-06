#!/usr/bin/env node

/**
 * Upload TEI files using the HTTP API, associating them with PDFs via fileref.
 *
 * Usage:
 *   node bin/upload-tei.js [options] <file1> [file2] [file3] ...
 *
 * Options:
 *   --env <path>              Path to .env file (default: ./.env)
 *   --user <username>         Username for authentication (default: from .env API_USER)
 *   --password <password>     Password for authentication (default: from .env API_PASSWORD)
 *   --base-url <url>          API base URL (default: from .env API_BASE_URL or http://localhost:8000)
 *   --title <text>            Edition title (default: from TEI /TEI/teiHeader/fileDesc/editionStmt/edition/title)
 *   --variant <id>            Variant ID (default: from TEI /TEI/teiHeader/encodingDesc/appInfo/application/label[@type='variant-id'])
 *
 * Arguments:
 *   file1 [file2] ...         One or more TEI XML files to upload
 *
 * Environment variables (from .env file):
 *   API_USER                  Username for authentication
 *   API_PASSWORD              Password for authentication
 *   API_BASE_URL              API base URL
 *
 * The script:
 * - Reads each TEI file
 * - Extracts the PDF reference from <idno type="fileref">
 * - Verifies the PDF exists
 * - Adds a revisionDesc/change entry marking the upload
 * - Uploads the TEI and associates it with the PDF
 */

import { Command } from 'commander';
import { readFile, access } from 'fs/promises';
import { resolve, basename } from 'path';
import { createHash } from 'crypto';
import { parseStringPromise, Builder } from 'xml2js';
import dotenv from 'dotenv';

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
 * Check if a PDF exists by doc_id
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} docId - PDF doc_id (fileref)
 * @returns {Promise<boolean>} - True if PDF exists
 */
async function pdfExists(baseUrl, sessionId, docId) {
  const response = await fetch(`${baseUrl}/api/v1/files/list`, {
    method: 'GET',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  if (!response.ok) {
    return false;
  }

  const data = await response.json();
  const files = data.files || data;

  // Check if any file has matching doc_id
  return files.some(f => f.doc_id === docId);
}

/**
 * Extract fileref from TEI document
 * @param {Object} teiDoc - Parsed TEI document (xml2js format)
 * @returns {string|null} - PDF doc_id or null
 */
function extractFileref(teiDoc) {
  try {
    // Look in editionStmt/edition/idno[@type='fileref'] (matches backend)
    const edition = teiDoc.TEI?.teiHeader?.[0]?.fileDesc?.[0]?.editionStmt?.[0]?.edition;
    if (edition && Array.isArray(edition)) {
      for (const ed of edition) {
        const idnos = ed.idno;
        if (idnos && Array.isArray(idnos)) {
          for (const idno of idnos) {
            if (idno.$?.type === 'fileref') {
              return idno._ || idno;
            }
          }
        }
      }
    }
  } catch (error) {
    // Silent catch - return null if structure not found
  }
  return null;
}

/**
 * Extract edition title from TEI document
 * @param {Object} teiDoc - Parsed TEI document (xml2js format)
 * @returns {string|null} - Edition title or null
 */
function extractEditionTitle(teiDoc) {
  try {
    const edition = teiDoc.TEI?.teiHeader?.[0]?.fileDesc?.[0]?.editionStmt?.[0]?.edition;
    if (!edition) return null;

    // edition might contain <title> or be a string directly
    if (Array.isArray(edition)) {
      for (const ed of edition) {
        if (ed.title) {
          return ed.title[0]._ || ed.title[0];
        }
      }
    }
  } catch (error) {
    // Silent catch
  }
  return null;
}

/**
 * Extract variant ID from TEI document
 * @param {Object} teiDoc - Parsed TEI document (xml2js format)
 * @returns {string|null} - Variant ID or null
 */
function extractVariantId(teiDoc) {
  try {
    const applications = teiDoc.TEI?.teiHeader?.[0]?.encodingDesc?.[0]?.appInfo?.[0]?.application;
    if (!applications) return null;

    for (const app of applications) {
      const labels = app.label;
      if (!labels) continue;

      for (const label of labels) {
        if (label.$?.type === 'variant-id') {
          return label._ || label;
        }
      }
    }
  } catch (error) {
    // Silent catch
  }
  return null;
}

/**
 * Add revisionDesc/change entry to TEI document
 * @param {Object} teiDoc - Parsed TEI document (xml2js format)
 * @param {string} username - Username for @who attribute
 * @returns {Object} - Modified TEI document
 */
function addRevisionChange(teiDoc, username) {
  const timestamp = new Date().toISOString();

  // Ensure revisionDesc exists
  if (!teiDoc.TEI.teiHeader[0].revisionDesc) {
    teiDoc.TEI.teiHeader[0].revisionDesc = [{ change: [] }];
  }

  const revisionDesc = teiDoc.TEI.teiHeader[0].revisionDesc[0];
  if (!revisionDesc.change) {
    revisionDesc.change = [];
  }

  // Add new change entry at the beginning
  revisionDesc.change.unshift({
    $: {
      when: timestamp,
      status: 'uploaded',
      who: `#${username}`
    },
    desc: ['Uploaded']
  });

  return teiDoc;
}

/**
 * Save TEI to server
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} xmlContent - TEI XML content (fileref, variant, title extracted from XML)
 * @returns {Promise<Object>} - Save response with status and stable_id
 */
async function saveTei(baseUrl, sessionId, xmlContent) {
  const response = await fetch(`${baseUrl}/api/v1/files/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({
      xml_string: xmlContent,
      new_version: true,  // Always create new version when uploading
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Save failed: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Process a single TEI file
 * @param {string} filePath - Path to TEI file
 * @param {Object} options - Processing options
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function processTeiFile(filePath, options) {
  const { baseUrl, sessionId, username, titleOverride, variantOverride } = options;
  const fileName = basename(filePath);

  try {
    // Check file exists
    try {
      await access(filePath);
    } catch {
      return { success: false, message: `File not found: ${filePath}` };
    }

    // Read and parse TEI
    const xmlContent = await readFile(filePath, 'utf-8');
    let teiDoc;

    try {
      teiDoc = await parseStringPromise(xmlContent);
    } catch (error) {
      return { success: false, message: `XML parse error: ${error.message}` };
    }

    // Extract fileref
    const fileref = extractFileref(teiDoc);
    if (!fileref) {
      return { success: false, message: 'No <idno type="fileref"> found in TEI' };
    }

    // Check PDF exists
    const pdfFound = await pdfExists(baseUrl, sessionId, fileref);
    if (!pdfFound) {
      return { success: false, message: `PDF not found: ${fileref}` };
    }

    // Apply title override if provided
    if (titleOverride) {
      const edition = teiDoc.TEI?.teiHeader?.[0]?.fileDesc?.[0]?.editionStmt?.[0]?.edition;
      if (edition && edition[0]) {
        if (!edition[0].title) {
          edition[0].title = [];
        }
        edition[0].title[0] = titleOverride;
      }
    }

    // Apply variant override if provided
    if (variantOverride) {
      const applications = teiDoc.TEI?.teiHeader?.[0]?.encodingDesc?.[0]?.appInfo?.[0]?.application;
      if (applications && applications.length > 0) {
        const extractorApp = applications.find(app => app.$?.type === 'extractor');
        if (extractorApp) {
          if (!extractorApp.label) {
            extractorApp.label = [];
          }
          // Find or create variant-id label
          let variantLabel = extractorApp.label.find(l => l.$?.type === 'variant-id');
          if (!variantLabel) {
            variantLabel = { $: { type: 'variant-id' }, _: variantOverride };
            extractorApp.label.push(variantLabel);
          } else {
            variantLabel._ = variantOverride;
          }
        }
      }
    }

    // Get final variant for reporting
    const variant = variantOverride || extractVariantId(teiDoc) || 'default';

    // Add revision entry
    addRevisionChange(teiDoc, username);

    // Convert back to XML
    const builder = new Builder({ headless: false });
    const modifiedXml = builder.buildObject(teiDoc);

    // Save to server (backend extracts fileref, variant, title from XML)
    await saveTei(baseUrl, sessionId, modifiedXml);

    return { success: true, message: `Uploaded to PDF ${fileref}, variant "${variant}"` };
  } catch (error) {
    return { success: false, message: `Error: ${error.message}` };
  }
}

/**
 * Main upload function
 * @param {Array<string>} files - Array of file paths
 * @param {Object} cmdOptions - Command options
 */
async function uploadTeiFiles(files, cmdOptions) {
  const {
    env: envPath,
    user: cliUser,
    password: cliPassword,
    baseUrl: cliBaseUrl,
    title: titleOverride,
    variant: variantOverride
  } = cmdOptions;

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

  console.log(`Processing ${files.length} TEI file(s)`);
  console.log(`Base URL: ${baseUrl}`);

  // Login
  console.log('\nLogging in...');
  const sessionId = await login(baseUrl, username, password);
  console.log('Login successful\n');

  // Process files
  let successCount = 0;
  let failCount = 0;

  for (const filePath of files) {
    process.stdout.write(`Processing ${basename(filePath)}... `);

    const result = await processTeiFile(filePath, {
      baseUrl,
      sessionId,
      username,
      titleOverride,
      variantOverride
    });

    if (result.success) {
      console.log(`✓ ${result.message}`);
      successCount++;
    } else {
      console.log(`✗ ${result.message}`);
      failCount++;
    }
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${files.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failCount}`);
}

// CLI setup
const program = new Command();

program
  .name('upload-tei')
  .description('Upload TEI files and associate with PDFs via fileref')
  .addHelpText('after', `
Examples:
  # Upload single TEI file
  $ node bin/upload-tei.js document.xml

  # Upload multiple files with custom variant
  $ node bin/upload-tei.js --variant annotated doc1.xml doc2.xml

  # Override title and variant
  $ node bin/upload-tei.js --title "Revised Edition" --variant v2 document.xml
`)
  .showHelpAfterError()
  .argument('<files...>', 'One or more TEI XML files to upload')
  .option('--env <path>', 'Path to .env file', './.env')
  .option('--user <username>', 'Username for authentication (default: from .env API_USER)')
  .option('--password <password>', 'Password for authentication (default: from .env API_PASSWORD)')
  .option('--base-url <url>', 'API base URL (default: from .env API_BASE_URL or http://localhost:8000)')
  .option('--title <text>', 'Edition title (overrides TEI content)')
  .option('--variant <id>', 'Variant ID (overrides TEI content)')
  .action(async (files, cmdOptions) => {
    try {
      await uploadTeiFiles(files, cmdOptions);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();

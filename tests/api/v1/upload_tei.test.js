/**
 * E2E Backend Tests for Upload TEI Script
 * @testCovers bin/upload-tei.js
 * @testCovers fastapi_app/routers/files_save.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { writeFile, mkdir, rm, copyFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseStringPromise } from 'xml2js';
import { logger } from '../helpers/test-logger.js';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

/**
 * Run the upload-tei script as a child process
 * @param {string[]} args - Command line arguments
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function runUploadTei(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['bin/upload-tei.js', ...args], {
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

describe('Upload TEI Script Tests', () => {
  let testDir = null;
  let envFile = null;
  let testTeiFile = null;
  let fixtureStableId = null;
  const FIXTURE_TEI = 'tests/api/fixtures/standard/files/10.5771__2699-1284-2024-3-149.tei.xml';
  const FIXTURE_DOC_ID = '10.5771__2699-1284-2024-3-149';

  // Setup: Find the fixture PDF stable_id
  test('Setup: find fixture PDF stable_id', async () => {
    const session = await login('admin', 'admin', BASE_URL);

    // Get files list
    const filesResponse = await authenticatedApiCall(
      session.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const files = filesResponse.files || filesResponse;

    // Debug: log all files to see what's available
    console.log(`DEBUG Found ${files.length} files:`, JSON.stringify(files.map(f => ({ stable_id: f.stable_id, doc_id: f.doc_id, filename: f.filename })), null, 2));

    // Find the fixture PDF by doc_id
    const fixturePdf = files.find(f => f.doc_id === FIXTURE_DOC_ID);
    assert.ok(fixturePdf, `Should find fixture PDF with doc_id ${FIXTURE_DOC_ID}`);

    fixtureStableId = fixturePdf.stable_id;
    logger.success(`Found fixture PDF: stable_id=${fixtureStableId}, doc_id=${fixturePdf.doc_id}`);
  });

  test('Setup: create test directory with TEI file', async () => {
    testDir = join(tmpdir(), `upload-tei-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Copy fixture TEI file to test directory
    testTeiFile = join(testDir, 'test-document.xml');
    await copyFile(FIXTURE_TEI, testTeiFile);

    logger.success(`Created test directory: ${testDir}`);
    logger.success(`Copied fixture TEI to: ${testTeiFile}`);
  });

  test('Setup: create .env file for authentication', async () => {
    envFile = join(testDir, '.env');
    const envContent = `API_USER=admin
API_PASSWORD=admin
API_BASE_URL=${BASE_URL}
`;
    await writeFile(envFile, envContent);
    logger.success(`Created .env file: ${envFile}`);
  });

  test('Upload TEI should require file arguments', async () => {
    const result = await runUploadTei([
      '--env', envFile,
    ]);

    assert.strictEqual(result.exitCode, 1, 'Should exit with error code');
    assert.ok(
      result.stderr.includes('required') || result.stderr.includes('argument'),
      'Should mention missing file argument'
    );

    logger.success('Rejected request without file arguments');
  });

  test('Upload TEI should successfully upload file with valid fileref', async () => {
    const result = await runUploadTei([
      testTeiFile,
      '--env', envFile,
    ]);

    console.log('DEBUG Exit code:', result.exitCode);
    console.log('DEBUG stdout:', result.stdout);
    console.log('DEBUG stderr:', result.stderr);

    assert.strictEqual(result.exitCode, 0, `Should exit successfully. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Login successful'), 'Should login successfully');
    assert.ok(result.stdout.includes('Processing test-document.xml'), 'Should process the file');
    assert.ok(
      result.stdout.includes(`Uploaded to PDF ${FIXTURE_DOC_ID}`),
      'Should upload to correct PDF doc_id'
    );
    assert.ok(result.stdout.includes('Success: 1'), 'Should report 1 success');
    assert.ok(result.stdout.includes('Failed: 0'), 'Should report 0 failures');

    logger.success('TEI file uploaded successfully');
  });

  test('Upload TEI should add revisionDesc/change entry', async () => {
    // Read the uploaded TEI from the server
    const session = await login('admin', 'admin', BASE_URL);

    const fileResponse = await authenticatedApiCall(
      session.sessionId,
      `/files/${fixtureStableId}`,
      'GET',
      null,
      BASE_URL
    );

    assert.ok(fileResponse.variants, 'File should have variants');
    const variant = fileResponse.variants.find(v => v.variant_id === 'grobid.training.segmentation');
    assert.ok(variant, 'Should find the uploaded variant');

    // Parse TEI XML
    const teiDoc = await parseStringPromise(variant.xml);
    const revisionDesc = teiDoc.TEI.teiHeader[0].revisionDesc;

    assert.ok(revisionDesc, 'Should have revisionDesc');
    assert.ok(revisionDesc[0].change, 'Should have change entries');

    // Find the upload change entry (should be first)
    const uploadChange = revisionDesc[0].change[0];
    assert.strictEqual(uploadChange.$.status, 'uploaded', 'Should have status="uploaded"');
    assert.strictEqual(uploadChange.$.who, '#admin', 'Should have who="#admin"');
    assert.ok(uploadChange.$.when, 'Should have when timestamp');
    assert.ok(uploadChange.desc, 'Should have desc element');
    assert.strictEqual(uploadChange.desc[0], 'Uploaded', 'Should have desc="Uploaded"');

    logger.success('revisionDesc/change entry added correctly');
  });

  test('Upload TEI should fail if PDF does not exist', async () => {
    // Create a TEI file with non-existent fileref
    const invalidTeiFile = join(testDir, 'invalid.xml');
    const teiContent = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>Test Edition</title>
          <idno type="fileref">nonexistent-pdf-id</idno>
        </edition>
      </editionStmt>
      <publicationStmt>
        <publisher>Test Publisher</publisher>
      </publicationStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>Test content</body>
  </text>
</TEI>`;
    await writeFile(invalidTeiFile, teiContent);

    const result = await runUploadTei([
      invalidTeiFile,
      '--env', envFile,
    ]);

    assert.strictEqual(result.exitCode, 0, 'Script should complete but report failure');
    assert.ok(result.stdout.includes('PDF not found'), 'Should report PDF not found');
    assert.ok(result.stdout.includes('Success: 0'), 'Should report 0 successes');
    assert.ok(result.stdout.includes('Failed: 1'), 'Should report 1 failure');

    logger.success('Correctly rejected TEI with non-existent PDF');
  });

  test('Upload TEI should fail if no fileref in TEI', async () => {
    // Create a TEI file without fileref
    const noFilerefTei = join(testDir, 'no-fileref.xml');
    const teiContent = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
      <publicationStmt>
        <publisher>Test Publisher</publisher>
      </publicationStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>Test content</body>
  </text>
</TEI>`;
    await writeFile(noFilerefTei, teiContent);

    const result = await runUploadTei([
      noFilerefTei,
      '--env', envFile,
    ]);

    assert.strictEqual(result.exitCode, 0, 'Script should complete but report failure');
    assert.ok(result.stdout.includes('No <idno type="fileref"> found'), 'Should report missing fileref');
    assert.ok(result.stdout.includes('Success: 0'), 'Should report 0 successes');
    assert.ok(result.stdout.includes('Failed: 1'), 'Should report 1 failure');

    logger.success('Correctly rejected TEI without fileref');
  });

  test('Upload TEI should support title override', async () => {
    const customTitle = 'Custom Edition Title';
    const result = await runUploadTei([
      testTeiFile,
      '--env', envFile,
      '--title', customTitle,
      '--variant', 'title-override-test',
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully');

    // Verify the title was set
    const session = await login('admin', 'admin', BASE_URL);
    const fileResponse = await authenticatedApiCall(
      session.sessionId,
      `/files/${fixtureStableId}`,
      'GET',
      null,
      BASE_URL
    );

    const variant = fileResponse.variants.find(v => v.variant_id === 'title-override-test');
    assert.ok(variant, 'Should find variant with custom title');

    const teiDoc = await parseStringPromise(variant.xml);
    const editionTitle = teiDoc.TEI.teiHeader[0].fileDesc[0].editionStmt[0].edition[0].title[0];

    assert.strictEqual(editionTitle, customTitle, 'Should use custom title');

    logger.success('Title override works correctly');
  });

  test('Upload TEI should support variant override', async () => {
    const customVariant = 'custom-variant-v2';
    const result = await runUploadTei([
      testTeiFile,
      '--env', envFile,
      '--variant', customVariant,
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully');

    // Verify the variant was used
    const session = await login('admin', 'admin', BASE_URL);
    const fileResponse = await authenticatedApiCall(
      session.sessionId,
      `/files/${fixtureStableId}`,
      'GET',
      null,
      BASE_URL
    );

    const variant = fileResponse.variants.find(v => v.variant_id === customVariant);
    assert.ok(variant, `Should find variant with ID ${customVariant}`);

    logger.success('Variant override works correctly');
  });

  test('Upload TEI should handle multiple files', async () => {
    // Copy the fixture file twice with different names
    const file1 = join(testDir, 'multi1.xml');
    const file2 = join(testDir, 'multi2.xml');
    await copyFile(FIXTURE_TEI, file1);
    await copyFile(FIXTURE_TEI, file2);

    const result = await runUploadTei([
      file1,
      file2,
      '--env', envFile,
      '--variant', 'multi-upload-test',
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
    assert.ok(result.stdout.includes('Processing 2 TEI file(s)'), 'Should process 2 files');
    assert.ok(result.stdout.includes('Success: 2'), 'Should report 2 successes');
    assert.ok(result.stdout.includes('Failed: 0'), 'Should report 0 failures');

    logger.success('Multiple file upload works correctly');
  });

  test('Upload TEI should use CLI credentials over .env', async () => {
    const result = await runUploadTei([
      testTeiFile,
      '--user', 'admin',
      '--password', 'admin',
      '--base-url', BASE_URL,
      '--variant', 'cli-auth-test',
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully with CLI credentials');
    assert.ok(result.stdout.includes('Success: 1'), 'Should process file successfully');

    logger.success('CLI credentials override worked correctly');
  });

  test('Cleanup: remove test directory', async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
      logger.success('Cleaned up test directory');
    }
  });
});

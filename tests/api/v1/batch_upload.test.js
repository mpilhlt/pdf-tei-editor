/**
 * E2E Backend Tests for Batch Extract Script
 * @testCovers bin/batch-extract.js
 * @testCovers fastapi_app/routers/files_upload.py
 * @testCovers fastapi_app/routers/extraction.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../helpers/test-logger.js';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Minimal valid PDF content - different for each test file to avoid deduplication
const SAMPLE_PDF_1 = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n/Contents 4 0 R\n>>\nendobj\n4 0 obj\n<<\n/Length 49\n>>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Test PDF 1) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000214 00000 n\ntrailer\n<<\n/Size 5\n/Root 1 0 R\n>>\nstartxref\n312\n%%EOF');

const SAMPLE_PDF_2 = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n/Contents 4 0 R\n>>\nendobj\n4 0 obj\n<<\n/Length 49\n>>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Test PDF 2) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000214 00000 n\ntrailer\n<<\n/Size 5\n/Root 1 0 R\n>>\nstartxref\n312\n%%EOF');

const SAMPLE_PDF_3 = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n/Contents 4 0 R\n>>\nendobj\n4 0 obj\n<<\n/Length 49\n>>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Test PDF 3) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000214 00000 n\ntrailer\n<<\n/Size 5\n/Root 1 0 R\n>>\nstartxref\n312\n%%EOF');

/**
 * Run the batch extract script as a child process
 * @param {string[]} args - Command line arguments
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function runBatchExtract(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['bin/batch-extract.js', ...args], {
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

describe('Batch Extract Script Tests', () => {
  let testDir = null;
  let envFile = null;

  // Setup: Create test directory with PDFs
  test('Setup: create test directory with sample PDFs', async () => {
    testDir = join(tmpdir(), `batch-extract-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Create subdirectory for recursive test
    const subdir = join(testDir, 'subdir');
    await mkdir(subdir, { recursive: true });

    // Create test PDFs with different content to avoid deduplication
    await writeFile(join(testDir, 'test1.pdf'), SAMPLE_PDF_1);
    await writeFile(join(testDir, 'test2.pdf'), SAMPLE_PDF_2);
    await writeFile(join(subdir, 'test3.pdf'), SAMPLE_PDF_3);

    logger.success(`Created test directory: ${testDir}`);
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

  test('Batch extract should use directory basename as default collection', async () => {
    const result = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--extractor', 'mock-extractor'
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
    // The collection name should be derived from testDir basename
    const expectedCollection = testDir.split('/').filter(Boolean).pop();
    assert.ok(
      result.stdout.includes(`Collection: ${expectedCollection}`) ||
      result.stdout.includes(`Creating collection '${expectedCollection}'`) ||
      result.stdout.includes(`Collection '${expectedCollection}' already exists`),
      `Should use directory basename '${expectedCollection}' as collection`
    );
    assert.ok(result.stdout.includes('Success:'), 'Should process files successfully');

    logger.success('Used directory basename as default collection');
  });

  test('Batch extract should require --extractor parameter', async () => {
    const result = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--collection', 'test_batch'
    ]);

    assert.strictEqual(result.exitCode, 1, 'Should exit with error code');
    assert.ok(
      result.stderr.includes('required option') && result.stderr.includes('--extractor'),
      'Should mention missing --extractor option'
    );

    logger.success('Rejected request without --extractor');
  });

  test('Batch extract should auto-create collection if it does not exist', async () => {
    const result = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--collection', 'test_batch_auto_created',
      '--extractor', 'mock-extractor',
      '--option', 'variant_id=test'
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
    assert.ok(
      result.stdout.includes('Creating collection') || result.stdout.includes('already exists'),
      'Should create or find collection'
    );
    assert.ok(result.stdout.includes('Success:'), 'Should process files successfully');

    logger.success('Auto-created collection successfully');
  });

  test('Batch extract should process PDFs (non-recursive)', async () => {
    const result = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--collection', 'test_batch',
      '--extractor', 'mock-extractor',
      '--option', 'variant_id=test'
    ]);

    logger.info('Exit code:', result.exitCode);
    logger.info('stdout:', result.stdout);
    if (result.stderr) {
      logger.error('stderr:', result.stderr);
    }

    assert.strictEqual(result.exitCode, 0, `Should exit successfully. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Found 2 PDF file(s)'), 'Should find 2 PDFs (excluding subdir)');
    assert.ok(result.stdout.includes('Success: 2'), 'Should process 2 files successfully');
    assert.ok(result.stdout.includes('Failed: 0'), 'Should have no failures');

    logger.success('Non-recursive batch extract completed successfully');
  });

  test('Batch extract should process PDFs recursively', async () => {
    const result = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--collection', 'test_batch_recursive',
      '--extractor', 'mock-extractor',
      '--option', 'variant_id=test',
      '--recursive'
    ]);

    logger.info('stdout:', result.stdout);
    if (result.stderr) {
      logger.info('stderr:', result.stderr);
    }

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully');
    assert.ok(result.stdout.includes('Found 3 PDF file(s)'), 'Should find 3 PDFs (including subdir)');
    assert.ok(result.stdout.includes('Success: 3'), 'Should process 3 files successfully');
    assert.ok(result.stdout.includes('Failed: 0'), 'Should have no failures');

    logger.success('Recursive batch extract completed successfully');
  });

  test('Batch extract should use CLI credentials over .env', async () => {
    const result = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--user', 'admin',
      '--password', 'admin',
      '--base-url', BASE_URL,
      '--collection', 'test_batch_cli',
      '--extractor', 'mock-extractor'
    ]);

    assert.strictEqual(result.exitCode, 0, 'Should exit successfully with CLI credentials');
    assert.ok(result.stdout.includes('Success:'), 'Should process files successfully');

    logger.success('CLI credentials override worked correctly');
  });

  test('Batch extract should skip already-processed files (resume)', async () => {
    // First run: process 2 files
    const firstRun = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--collection', 'test_resume',
      '--extractor', 'mock-extractor'
    ]);

    assert.strictEqual(firstRun.exitCode, 0, 'First run should succeed');
    assert.ok(firstRun.stdout.includes('Processing 2 new file(s)'), 'Should process 2 new files');
    assert.ok(firstRun.stdout.includes('Success: 2'), 'Should succeed on 2 files');

    logger.success('First run completed');

    // Second run: should skip the 2 files that already exist
    const secondRun = await runBatchExtract([
      testDir,
      '--env', envFile,
      '--collection', 'test_resume',
      '--extractor', 'mock-extractor'
    ]);

    assert.strictEqual(secondRun.exitCode, 0, 'Second run should succeed');
    assert.ok(secondRun.stdout.includes('Found 2 existing file(s)'), 'Should find 2 existing files');
    assert.ok(secondRun.stdout.includes('Skipping 2 file(s)'), 'Should skip 2 existing files');
    assert.ok(secondRun.stdout.includes('All files already processed'), 'Should report all files processed');
    assert.ok(secondRun.stdout.includes('Already processed: 2'), 'Should show 2 already processed');
    assert.ok(secondRun.stdout.includes('New: 0'), 'Should show 0 new files');

    logger.success('Resume functionality works - skipped already-processed files');
  });

  test('Verify files were extracted successfully', async () => {
    // Login as admin to check that files exist
    const session = await login('admin', 'admin', BASE_URL);

    const filesResponse = await authenticatedApiCall(
      session.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const files = filesResponse.files || filesResponse;

    // Just verify that files were extracted - we extracted 2 PDFs in test_batch,
    // 3 PDFs in test_batch_recursive, and 2 PDFs in test_batch_cli
    // However, since they're the same files (content-wise), deduplication means
    // we should have at least 2 unique document groups
    assert.ok(files.length >= 2, `Should have at least 2 file groups from batch extract. Found ${files.length}`);

    logger.success(`Found ${files.length} document groups from batch extract`);
  });

  test('Cleanup: remove test directory', async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
      logger.success('Cleaned up test directory');
    }
  });
});

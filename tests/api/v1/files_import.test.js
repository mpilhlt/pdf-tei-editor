/**
 * API integration tests for /api/v1/import
 *
 * @testCovers fastapi_app/routers/files_import.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, API_BASE } from '../helpers/test-auth.js';
import AdmZip from 'adm-zip';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';

describe('File Import API', () => {
  let sessionId;

  /**
   * Create a test ZIP file with specified structure
   * @param {Object} structure - Object mapping paths to content (strings or buffers)
   * @param {string} rootDir - Root directory name inside zip
   * @returns {Promise<string>} Path to created zip file
   */
  async function createTestZip(structure, rootDir = 'export') {
    const zip = new AdmZip();

    for (const [path, content] of Object.entries(structure)) {
      const arcname = rootDir ? `${rootDir}/${path}` : path;
      zip.addFile(arcname, Buffer.from(content));
    }

    // Write to temp file
    const tempZipPath = join(tmpdir(), `test-import-${Date.now()}.zip`);
    await writeFile(tempZipPath, zip.toBuffer());
    return tempZipPath;
  }

  /**
   * Upload a ZIP file to the import endpoint
   * @param {string} zipPath - Path to zip file
   * @param {string} sessionId - Session ID for authentication
   * @param {Object} params - Additional query parameters
   * @returns {Promise<Response>}
   */
  async function uploadZip(zipPath, sessionId, params = {}) {
    const formData = new FormData();
    const zipBuffer = await readFile(zipPath);
    const blob = new Blob([zipBuffer], { type: 'application/zip' });
    formData.append('file', blob, 'test.zip');

    // Build query string
    const queryParams = new URLSearchParams({ sessionId, ...params });
    const url = `${API_BASE}/import?${queryParams}`;

    return fetch(url, {
      method: 'POST',
      body: formData
    });
  }

  const TEST_PDF = "%PDF-1.4\nTest PDF content\n%%EOF";
  const TEST_TEI = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt><title>Test Document</title></titleStmt>
            <publicationStmt><publisher>Test</publisher></publicationStmt>
            <sourceDesc>
                <biblStruct>
                    <analytic><title>Test Document</title></analytic>
                    <monogr><imprint><date>2024</date></imprint></monogr>
                    <idno type="DOI">10.1234/test-import</idno>
                </biblStruct>
            </sourceDesc>
        </fileDesc>
    </teiHeader>
    <text><body><p>Test content</p></body></text>
</TEI>`;

  test('should login as admin', async () => {
    const result = await login('admin', 'admin');
    sessionId = result.sessionId;
    assert.ok(sessionId, 'Should get session ID');
  });

  test('POST /api/v1/import - should require authentication', async () => {
    const zipPath = await createTestZip({
      'pdf/test.pdf': TEST_PDF
    });

    try {
      const formData = new FormData();
      const zipBuffer = await readFile(zipPath);
      const blob = new Blob([zipBuffer], { type: 'application/zip' });
      formData.append('file', blob, 'test.zip');

      const response = await fetch(`${API_BASE}/import`, {
        method: 'POST',
        body: formData
      });

      assert.strictEqual(response.status, 401, 'Should return 401 without session');
    } finally {
      await unlink(zipPath);
    }
  });

  test('POST /api/v1/import - should import basic structure', async () => {
    const zipPath = await createTestZip({
      'pdf/10.1234__test-import.pdf': TEST_PDF,
      'tei/10.1234__test-import.tei.xml': TEST_TEI
    });

    try {
      const response = await uploadZip(zipPath, sessionId);

      assert.strictEqual(response.status, 200, 'Should return 200 OK');

      const stats = await response.json();
      assert.ok(stats.files_scanned >= 2, 'Should scan at least 2 files');
      assert.ok(stats.files_imported >= 0, 'Should report imported files');
      assert.ok(Array.isArray(stats.errors), 'Should return errors array');

      console.log(`Import stats: ${stats.files_imported} imported, ${stats.files_skipped} skipped, ${stats.errors.length} errors`);
    } finally {
      await unlink(zipPath);
    }
  });

  test('POST /api/v1/import - should import with collection assignment', async () => {
    const zipPath = await createTestZip({
      'pdf/test-collection.pdf': TEST_PDF,
      'tei/test-collection.tei.xml': TEST_TEI.replace('10.1234/test-import', 'test-collection')
    });

    try {
      const response = await uploadZip(zipPath, sessionId, { collection: 'test-import-collection' });

      assert.strictEqual(response.status, 200, 'Should return 200 OK');

      const stats = await response.json();
      assert.ok(stats.files_scanned >= 2, 'Should scan files');
    } finally {
      await unlink(zipPath);
    }
  });

  test('POST /api/v1/import - should reject non-zip files', async () => {
    const tempPath = join(tmpdir(), `test-import-${Date.now()}.txt`);
    await writeFile(tempPath, 'not a zip file');

    try {
      const formData = new FormData();
      const buffer = await readFile(tempPath);
      const blob = new Blob([buffer], { type: 'text/plain' });
      formData.append('file', blob, 'test.txt');

      const queryParams = new URLSearchParams({ sessionId });
      const response = await fetch(`${API_BASE}/import?${queryParams}`, {
        method: 'POST',
        body: formData
      });

      assert.strictEqual(response.status, 400, 'Should return 400 for non-zip file');
    } finally {
      await unlink(tempPath);
    }
  });

  test('POST /api/v1/import - should reject empty zip', async () => {
    const zip = new AdmZip();
    const tempZipPath = join(tmpdir(), `test-import-empty-${Date.now()}.zip`);
    await writeFile(tempZipPath, zip.toBuffer());

    try {
      const response = await uploadZip(tempZipPath, sessionId);

      assert.strictEqual(response.status, 400, 'Should return 400 for empty zip');

      const error = await response.json();
      assert.ok(error.detail, 'Should return error detail');
      console.log(`Empty zip error: ${error.detail}`);
    } finally {
      await unlink(tempZipPath);
    }
  });

  test('POST /api/v1/import - should handle recursive collections', async () => {
    const zipPath = await createTestZip({
      'collection1/pdf/doc1.pdf': TEST_PDF,
      'collection1/tei/doc1.tei.xml': TEST_TEI.replace('10.1234/test-import', 'doc1'),
      'collection2/pdf/doc2.pdf': TEST_PDF,
      'collection2/tei/doc2.tei.xml': TEST_TEI.replace('10.1234/test-import', 'doc2')
    });

    try {
      const response = await uploadZip(zipPath, sessionId, { recursive_collections: 'true' });

      assert.strictEqual(response.status, 200, 'Should return 200 OK');

      const stats = await response.json();
      assert.ok(stats.files_scanned >= 4, 'Should scan at least 4 files');

      console.log(`Recursive collections import: ${stats.files_imported} imported`);
    } finally {
      await unlink(zipPath);
    }
  });

  test('POST /api/v1/import - should reject invalid zip file', async () => {
    const tempPath = join(tmpdir(), `test-import-invalid-${Date.now()}.zip`);
    await writeFile(tempPath, 'invalid zip content');

    try {
      const response = await uploadZip(tempPath, sessionId);

      assert.strictEqual(response.status, 400, 'Should return 400 for invalid zip');

      const error = await response.json();
      assert.ok(error.detail, 'Should return error detail');
      console.log(`Invalid zip error: ${error.detail}`);
    } finally {
      await unlink(tempPath);
    }
  });
});

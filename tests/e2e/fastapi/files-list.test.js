/**
 * E2E tests for Files List API endpoint
 * @testCovers backend/api/files.py
 * @testCovers backend/lib/file_data.py
 * @testCovers backend/lib/access_control.py
 * @testCovers backend/lib/cache_manager.py
 * @testCovers backend/lib/locking.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession } from '../helpers/test-auth.js';

const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

describe('Files List API', () => {

  test('should return file list without authentication', async () => {
    const response = await fetch(`${API_BASE}/files/list`);

    assert.strictEqual(response.status, 200);
    const files = await response.json();

    // Should return an array
    assert(Array.isArray(files), 'Response should be an array');

    // Each file should have required structure
    if (files.length > 0) {
      const file = files[0];
      assert(typeof file.id === 'string', 'File should have id string');
      assert(file.versions === undefined || Array.isArray(file.versions), 'Versions should be array if present');
      assert(file.gold === undefined || Array.isArray(file.gold), 'Gold should be array if present');
    }
  });

  test('should return file list with authentication', async () => {
    const { sessionId } = await createTestSession();

    const response = await fetch(`${API_BASE}/files/list`, {
      headers: {
        'X-Session-ID': sessionId
      }
    });

    assert.strictEqual(response.status, 200);
    const files = await response.json();
    assert(Array.isArray(files), 'Response should be an array');
  });

  test('should support variant filtering', async () => {
    const response = await fetch(`${API_BASE}/files/list?variant=`);

    assert.strictEqual(response.status, 200);
    const files = await response.json();
    assert(Array.isArray(files), 'Response should be an array');
  });

  test('should support refresh parameter', async () => {
    const response = await fetch(`${API_BASE}/files/list?refresh=true`);

    assert.strictEqual(response.status, 200);
    const files = await response.json();
    assert(Array.isArray(files), 'Response should be an array');
  });

  test('should include file metadata fields', async () => {
    const response = await fetch(`${API_BASE}/files/list`);

    assert.strictEqual(response.status, 200);
    const files = await response.json();

    if (files.length > 0) {
      const file = files[0];

      // Check required fields
      assert(typeof file.id === 'string', 'File should have id');

      // Check optional metadata fields exist (can be null/undefined)
      const metadataFields = ['label', 'author', 'title', 'date', 'doi', 'fileref', 'collection'];
      for (const field of metadataFields) {
        assert(file.hasOwnProperty(field), `File should have ${field} property`);
      }

      // Check structure fields
      const structureFields = ['pdf', 'gold', 'versions'];
      for (const field of structureFields) {
        assert(file.hasOwnProperty(field), `File should have ${field} property`);
      }
    }
  });

  test('should handle variant filtering with specific variant', async () => {
    const response = await fetch(`${API_BASE}/files/list?variant=grobid`);

    assert.strictEqual(response.status, 200);
    const files = await response.json();
    assert(Array.isArray(files), 'Response should be an array');
  });

  test('should return same structure for multiple requests', async () => {
    // First request
    const response1 = await fetch(`${API_BASE}/files/list`);
    assert.strictEqual(response1.status, 200);
    const files1 = await response1.json();

    // Second request (should use cache)
    const response2 = await fetch(`${API_BASE}/files/list`);
    assert.strictEqual(response2.status, 200);
    const files2 = await response2.json();

    // Should have same structure
    assert.strictEqual(files1.length, files2.length, 'File count should be consistent');

    if (files1.length > 0) {
      assert.deepStrictEqual(
        Object.keys(files1[0]).sort(),
        Object.keys(files2[0]).sort(),
        'File structure should be consistent'
      );
    }
  });

  test('should handle empty file list gracefully', async () => {
    // This test ensures the endpoint works even if no files exist
    const response = await fetch(`${API_BASE}/files/list`);

    assert.strictEqual(response.status, 200);
    const files = await response.json();
    assert(Array.isArray(files), 'Response should always be an array');
  });

});
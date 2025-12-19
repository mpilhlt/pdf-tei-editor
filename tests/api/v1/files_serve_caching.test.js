/**
 * E2E Backend Tests for File Serve Caching Issue
 * @testCovers fastapi_app/routers/files_serve.py
 * @testCovers fastapi_app/routers/files_save.py
 *
 * Tests the issue where file content changes are not reflected after save
 * due to browser HTTP caching. This reproduces the user-reported issue where:
 * 1. Open an XML file for the first time
 * 2. Apply the "Add RNG schema definition" enhancement (adds xml-model PI)
 * 3. Save the file
 * 4. Navigate to a different document
 * 5. Navigate back
 * Expected: New content with xml-model PI
 * Actual: Old content without xml-model PI (due to browser cache)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Sample TEI XML template
const createTeiXml = (docId, content, includeXmlModelPI = false) => {
  const xmlModelPI = includeXmlModelPI
    ? '<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>\n'
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
${xmlModelPI}<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document ${docId}</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>Cache Test Edition</title>
          <idno type="fileref">${docId}</idno>
        </edition>
      </editionStmt>
      <publicationStmt>
        <p>Test publication</p>
      </publicationStmt>
      <sourceDesc>
        <p>Test source</p>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <p>${content}</p>
      </div>
    </body>
  </text>
</TEI>`;
};

describe('File Serve Caching Issue Tests', () => {
  let reviewerSession = null;
  const testRunId = Math.random().toString(36).substring(2, 15);
  const testState = {
    docId: `test-cache-${testRunId}`,
    stableId: null,
  };

  test('Setup: login as reviewer', async () => {
    reviewerSession = await login('reviewer', 'reviewer', BASE_URL);
    assert.ok(reviewerSession?.sessionId, 'Should have reviewer session');
    logger.success('Reviewer session created');
  });

  test('Step 1: Create initial file without xml-model PI', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Initial content without schema', false);

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.docId,
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'new_gold', 'Should create new gold standard');
    assert.ok(response.file_id, 'Should return stable_id');

    testState.stableId = response.file_id;
    logger.success(`Created file: ${testState.stableId}`);

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  test('Step 2: Fetch file content (simulates initial load)', async () => {
    const response = await fetch(`${BASE_URL}/api/files/${testState.stableId}`, {
      headers: {
        'X-Session-ID': reviewerSession.sessionId
      }
    });

    assert.ok(response.ok, 'Should fetch file successfully');
    const content = await response.text();

    assert.ok(content.includes('Initial content without schema'), 'Should contain initial content');
    assert.ok(!content.includes('<?xml-model'), 'Should NOT contain xml-model PI');

    logger.success('Initial file content fetched (without xml-model PI)');
  });

  test('Step 3: Update file with xml-model PI (simulates TEI Wizard enhancement)', async () => {
    const updatedXml = createTeiXml(testState.docId, 'Initial content without schema', true);

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.stableId,
        xml_string: updatedXml,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should update file');
    assert.strictEqual(response.file_id, testState.stableId, 'Stable ID should remain the same');

    logger.success('File updated with xml-model PI');

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  test('Step 4: Fetch file again (simulates navigation back)', async () => {
    // This simulates what happens when the user navigates away and back
    // Without proper cache control, the browser would serve cached content
    const response = await fetch(`${BASE_URL}/api/files/${testState.stableId}`, {
      headers: {
        'X-Session-ID': reviewerSession.sessionId
      }
    });

    assert.ok(response.ok, 'Should fetch file successfully');
    const content = await response.text();

    // Check cache headers
    const cacheControl = response.headers.get('Cache-Control');
    const etag = response.headers.get('ETag');
    const lastModified = response.headers.get('Last-Modified');

    logger.info(`Cache-Control: ${cacheControl || 'not set'}`);
    logger.info(`ETag: ${etag || 'not set'}`);
    logger.info(`Last-Modified: ${lastModified || 'not set'}`);

    // The critical assertion: the file SHOULD contain the xml-model PI
    if (!content.includes('<?xml-model')) {
      logger.error('ISSUE REPRODUCED: File content is stale (missing xml-model PI)');
      logger.error('This indicates browser caching is serving old content');

      // If cache headers are not set properly, this is the root cause
      if (!cacheControl || cacheControl.includes('public') || cacheControl.includes('max-age')) {
        logger.error('Root cause: Missing or incorrect Cache-Control headers');
        logger.error('Solution: Add "Cache-Control: no-cache, no-store, must-revalidate" to file serve endpoint');
      }

      assert.fail('File content should contain xml-model PI after save (caching issue detected)');
    }

    assert.ok(content.includes('<?xml-model'), 'Should contain xml-model PI');
    logger.success('File content correctly updated (xml-model PI present)');
  });

  test('Step 5: Verify cache headers prevent stale content', async () => {
    const response = await fetch(`${BASE_URL}/api/files/${testState.stableId}`, {
      headers: {
        'X-Session-ID': reviewerSession.sessionId
      }
    });

    const cacheControl = response.headers.get('Cache-Control');
    const pragma = response.headers.get('Pragma');
    const expires = response.headers.get('Expires');

    // Verify proper cache control headers are set
    assert.ok(cacheControl, 'Cache-Control header should be set');
    assert.ok(
      cacheControl.includes('no-cache') &&
      cacheControl.includes('no-store') &&
      cacheControl.includes('must-revalidate'),
      `Cache-Control should prevent caching: ${cacheControl}`
    );
    assert.strictEqual(pragma, 'no-cache', 'Pragma header should be no-cache');
    assert.strictEqual(expires, '0', 'Expires header should be 0');

    logger.success(`Cache headers correctly set:`);
    logger.success(`  Cache-Control: ${cacheControl}`);
    logger.success(`  Pragma: ${pragma}`);
    logger.success(`  Expires: ${expires}`);
  });

  test('Cleanup: delete test file', async () => {
    if (testState.stableId) {
      try {
        await authenticatedApiCall(
          reviewerSession.sessionId,
          '/files/delete',
          'POST',
          { files: [testState.stableId] },
          BASE_URL
        );
        logger.success('Cleaned up test file');
      } catch (error) {
        logger.warn(`Cleanup error (non-critical): ${error.message}`);
      }
    }
  });
});

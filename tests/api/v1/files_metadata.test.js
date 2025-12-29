/**
 * E2E Backend Tests for Files Metadata API
 * @testCovers fastapi_app/routers/files_metadata.py
 * @testCovers fastapi_app/lib/file_repository.py
 *
 * Tests cover:
 * - Update file label
 * - Update file variant
 * - Update multiple metadata fields
 * - Access control enforcement
 * - Error handling (file not found, no fields provided)
 * - Set gold standard status
 * - Gold standard role-based access control
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

/**
 * Find file by ID in files list response (checks both source and artifacts)
 */
function findFileById(listData, fileId) {
  for (const doc of listData.files) {
    if (doc.source?.id === fileId) {
      return doc.source;
    }
    const artifact = doc.artifacts?.find(a => a.id === fileId);
    if (artifact) {
      return artifact;
    }
  }
  return null;
}

// Sample TEI XML template
const createTeiXml = (docId, label = 'Initial Version') => {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document ${docId}</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>${label}</title>
          <idno type="fileref">${docId}</idno>
        </edition>
      </editionStmt>
      <publicationStmt>
        <p>Test publication</p>
      </publicationStmt>
      <sourceDesc>
        <bibl>Test source</bibl>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <p>Test content</p>
      </div>
    </body>
  </text>
</TEI>`;
};

describe('Files Metadata API E2E Tests', () => {
  let reviewerSession = null;
  const testRunId = Math.random().toString(36).substring(2, 15);

  // Shared test state
  const testState = {
    docId: `test-metadata-${testRunId}`,
    fileStableId: null,
    versionStableId: null, // For testing gold standard promotion
  };

  // Setup: Login session
  test('Setup: login as reviewer', async () => {
    reviewerSession = await login('reviewer', 'reviewer', BASE_URL);
    assert.ok(reviewerSession?.sessionId, 'Should have reviewer session');
    logger.success('Reviewer session created');
  });

  // Create test file
  test('Setup: create test file', async () => {
    const xmlContent = createTeiXml(testState.docId);

    const data = await authenticatedApiCall(
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

    assert.strictEqual(data.status, 'new_gold', 'Should create new gold file');
    testState.fileStableId = data.file_id;
    assert.ok(testState.fileStableId, 'Should have file stable_id');
    logger.success(`Created test file: ${testState.fileStableId}`);
  });

  // Test 1: Update file label
  test('PATCH /api/v1/files/{stable_id}/metadata should update file label', async () => {
    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.fileStableId}/metadata`,
      'PATCH',
      {
        label: 'Updated Label'
      },
      BASE_URL
    );

    assert.strictEqual(data.message, 'File metadata updated successfully');

    // Verify the update by fetching file list
    const listData = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const file = findFileById(listData, testState.fileStableId);
    assert.ok(file, `File ${testState.fileStableId} should be found in files list`);
    assert.strictEqual(file.label, 'Updated Label', 'Label should be updated');
    logger.success('Label updated successfully');
  });

  // Test 2: Update file variant (note: gold files are "source" not "artifacts", so variant field isn't in FileItemModel)
  test('PATCH /api/v1/files/{stable_id}/metadata should update file variant', async () => {
    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.fileStableId}/metadata`,
      'PATCH',
      {
        variant: 'test-variant'
      },
      BASE_URL
    );

    assert.strictEqual(data.message, 'File metadata updated successfully');
    logger.success('Variant update accepted (Note: variant not visible in list response for gold/source files)');
  });

  // Test 3: Update multiple metadata fields
  test('PATCH /api/v1/files/{stable_id}/metadata should update multiple fields', async () => {
    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.fileStableId}/metadata`,
      'PATCH',
      {
        label: 'Multi-field Update',
        variant: 'multi-variant'
      },
      BASE_URL
    );

    assert.strictEqual(data.message, 'File metadata updated successfully');

    // Verify label update (variant not visible for gold/source files)
    const listData = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );
    const file = findFileById(listData, testState.fileStableId);
    assert.ok(file, `File ${testState.fileStableId} should be found in files list`);
    assert.strictEqual(file.label, 'Multi-field Update', 'Label should be updated');
    logger.success('Multiple fields updated successfully');
  });

  // Test 4: Error - non-existent file (should throw, authenticatedApiCall throws on error)
  test('PATCH /api/v1/files/{stable_id}/metadata should return 404 for non-existent file', async () => {
    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        '/files/nonexistent123/metadata',
        'PATCH',
        {
          label: 'Should Fail'
        },
        BASE_URL
      );
      assert.fail('Should have thrown 404 error');
    } catch (error) {
      assert.match(error.message, /404/i, 'Should throw 404 error');
      assert.match(error.message, /File not found/i, 'Should have appropriate error message');
      logger.success('404 error handled correctly');
    }
  });

  // Test 5: Error - no metadata fields provided
  test('PATCH /api/v1/files/{stable_id}/metadata should return 400 when no fields provided', async () => {
    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        `/files/${testState.fileStableId}/metadata`,
        'PATCH',
        {},
        BASE_URL
      );
      assert.fail('Should have thrown 400 error');
    } catch (error) {
      assert.match(error.message, /400/i, 'Should throw 400 error');
      assert.match(error.message, /No metadata fields provided/i, 'Should have appropriate error message');
      logger.success('400 error handled correctly');
    }
  });

  // Test 6: Clear variant field (note: variant not visible for gold/source files in list response)
  test('PATCH /api/v1/files/{stable_id}/metadata should allow clearing variant field', async () => {
    // First set a variant
    const data1 = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.fileStableId}/metadata`,
      'PATCH',
      { variant: 'temp-variant' },
      BASE_URL
    );
    assert.strictEqual(data1.message, 'File metadata updated successfully');

    // Then clear it
    const data2 = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.fileStableId}/metadata`,
      'PATCH',
      { variant: '' },
      BASE_URL
    );
    assert.strictEqual(data2.message, 'File metadata updated successfully');
    logger.success('Variant cleared successfully (Note: variant updates work but not visible for gold/source files)');
  });

  // Gold Standard Tests

  // Test 7: Create a version to test gold standard promotion
  test('Setup: create version for gold standard test', async () => {
    // Modify the XML content to create a different version
    const xmlContent = createTeiXml(testState.docId, 'Version for Gold Test').replace(
      '<p>Test content</p>',
      '<p>Test content - modified for version test</p>'
    );

    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.fileStableId,
        xml_string: xmlContent,
        new_version: true
      },
      BASE_URL
    );

    // When creating a new version from an existing file, the status can be 'new_version' or 'new'
    // depending on whether content changed
    assert.ok(['new_version', 'new'].includes(data.status), `Status should be new_version or new, got: ${data.status}`);
    testState.versionStableId = data.file_id;
    assert.ok(testState.versionStableId, 'Should have version stable_id');
    assert.notStrictEqual(testState.versionStableId, testState.fileStableId, 'Version should have different ID');
    logger.success(`Created test version: ${testState.versionStableId}`);
  });

  // Test 8: Verify both files exist before gold standard test
  test('Verify both files exist', async () => {
    const listData = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const goldFile = findFileById(listData, testState.fileStableId);
    const versionFile = findFileById(listData, testState.versionStableId);

    assert.ok(goldFile, 'Original gold file should exist');
    assert.ok(versionFile, 'New version should exist');
    logger.success('Both files exist');
  });

  // Test 9: Set version as gold standard
  test('POST /api/v1/files/{stable_id}/gold-standard should promote version to gold', async () => {
    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.versionStableId}/gold-standard`,
      'POST',
      null,
      BASE_URL
    );

    assert.strictEqual(data.message, 'File set as gold standard successfully');
    logger.success('Gold standard set via API');

    // Verify both files still exist after promotion
    const listData = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const newGoldFile = findFileById(listData, testState.versionStableId);
    const oldGoldFile = findFileById(listData, testState.fileStableId);

    assert.ok(newGoldFile, 'Promoted file should exist');
    assert.ok(oldGoldFile, 'Original file should still exist');
    logger.success('Gold standard promoted successfully');
  });

  // Test 10: Error - non-reviewer cannot set gold standard
  test('POST /api/v1/files/{stable_id}/gold-standard should deny access to non-reviewers', async () => {
    // Login as annotator
    const annotatorSession = await login('annotator', 'annotator', BASE_URL);
    assert.ok(annotatorSession?.sessionId, 'Should have annotator session');

    try {
      await authenticatedApiCall(
        annotatorSession.sessionId,
        `/files/${testState.fileStableId}/gold-standard`,
        'POST',
        null,
        BASE_URL
      );
      assert.fail('Should have thrown 403 error');
    } catch (error) {
      assert.match(error.message, /403/i, 'Should throw 403 error');
      assert.match(error.message, /Only reviewers and admins can set gold standard/i, 'Should have appropriate error message');
      logger.success('Role-based access control enforced');
    }
  });

  // Test 11: Error - non-existent file
  test('POST /api/v1/files/{stable_id}/gold-standard should return 404 for non-existent file', async () => {
    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        '/files/nonexistent456/gold-standard',
        'POST',
        null,
        BASE_URL
      );
      assert.fail('Should have thrown 404 error');
    } catch (error) {
      assert.match(error.message, /404/i, 'Should throw 404 error');
      assert.match(error.message, /File not found/i, 'Should have appropriate error message');
      logger.success('404 error handled correctly');
    }
  });
});

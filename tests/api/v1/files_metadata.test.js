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
 * - Update document ID (doc_id)
 * - Document ID update for all files in document
 * - Document ID role-based access control (reviewer only)
 * - Document ID gold file requirement
 * - Document ID validation (empty, encoded formats)
 * - Fileref update in XML content for all TEI files
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

  // Document ID Update Tests

  // Test 12: Update doc_id for gold file
  test('PATCH /api/v1/files/{stable_id}/doc-id should update doc_id for gold file', async () => {
    const newDocId = `test-metadata-updated-${testRunId}`;

    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.versionStableId}/doc-id`,
      'PATCH',
      { doc_id: newDocId },
      BASE_URL
    );

    assert.strictEqual(data.message, 'Document ID updated successfully');
    logger.success('Doc ID updated successfully');

    // Verify the update using metadata endpoint
    const metadata = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.versionStableId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(metadata.doc_id, newDocId, 'Doc ID should be updated');
    logger.success(`Verified doc_id updated to: ${newDocId}`);

    // Verify all files with same doc_id were updated (including the old gold file)
    const oldGoldMetadata = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.fileStableId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(oldGoldMetadata.doc_id, newDocId, 'All files in document should have updated doc_id');
    logger.success('All document files have updated doc_id');
  });

  // Test 13: Error - non-gold file cannot update doc_id
  test('PATCH /api/v1/files/{stable_id}/doc-id should reject non-gold files', async () => {
    // Create a new version to test with
    const xmlContent = createTeiXml(testState.docId, 'Version for Non-Gold Test').replace(
      '<p>Test content</p>',
      '<p>Test content - non-gold test version</p>'
    );

    const versionData = await authenticatedApiCall(
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

    const nonGoldFileId = versionData.file_id;
    assert.ok(nonGoldFileId, 'Should have created non-gold version');

    // Try to update doc_id of the non-gold file
    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        `/files/${nonGoldFileId}/doc-id`,
        'PATCH',
        { doc_id: 'should-fail' },
        BASE_URL
      );
      assert.fail('Should have thrown an error');
    } catch (error) {
      // Should throw 400 error with message about gold standard files
      assert.ok(error.message.match(/400/i) || error.message.match(/Only gold standard files/i),
        `Expected error about gold standard requirement, got: ${error.message}`);
      logger.success('Non-gold file rejection enforced');
    }
  });

  // Test 14: Error - non-reviewer cannot update doc_id
  test('PATCH /api/v1/files/{stable_id}/doc-id should deny access to non-reviewers', async () => {
    // Login as annotator
    const annotatorSession = await login('annotator', 'annotator', BASE_URL);
    assert.ok(annotatorSession?.sessionId, 'Should have annotator session');

    try {
      await authenticatedApiCall(
        annotatorSession.sessionId,
        `/files/${testState.fileStableId}/doc-id`,
        'PATCH',
        { doc_id: 'should-fail' },
        BASE_URL
      );
      assert.fail('Should have thrown 403 error');
    } catch (error) {
      assert.match(error.message, /403/i, 'Should throw 403 error');
      assert.match(error.message, /Only reviewers and admins can update document ID/i, 'Should have appropriate error message');
      logger.success('Role-based access control enforced for doc_id update');
    }
  });

  // Test 15: Error - empty doc_id
  test('PATCH /api/v1/files/{stable_id}/doc-id should reject empty doc_id', async () => {
    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        `/files/${testState.fileStableId}/doc-id`,
        'PATCH',
        { doc_id: '' },
        BASE_URL
      );
      assert.fail('Should have thrown 400 error');
    } catch (error) {
      assert.match(error.message, /400/i, 'Should throw 400 error');
      logger.success('Empty doc_id rejected');
    }
  });

  // Test 16: Error - non-existent file
  test('PATCH /api/v1/files/{stable_id}/doc-id should return 404 for non-existent file', async () => {
    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        '/files/nonexistent789/doc-id',
        'PATCH',
        { doc_id: 'should-fail' },
        BASE_URL
      );
      assert.fail('Should have thrown 404 error');
    } catch (error) {
      assert.match(error.message, /404/i, 'Should throw 404 error');
      assert.match(error.message, /File not found/i, 'Should have appropriate error message');
      logger.success('404 error handled correctly for doc_id update');
    }
  });

  // Test 17: Update doc_id with filesystem-unsafe characters (encoded)
  test('PATCH /api/v1/files/{stable_id}/doc-id should accept encoded doc_id', async () => {
    // Use the versionStableId which is currently gold (from test 12)
    const goldFileId = testState.versionStableId;

    // Use encoded format (e.g., DOI with __ instead of /)
    const encodedDocId = `10.1234__test-encoded-${testRunId}`;

    const data = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${goldFileId}/doc-id`,
      'PATCH',
      { doc_id: encodedDocId },
      BASE_URL
    );

    assert.strictEqual(data.message, 'Document ID updated successfully');
    logger.success('Encoded doc_id accepted');

    // Verify the update
    const metadata = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${goldFileId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(metadata.doc_id, encodedDocId, 'Encoded doc_id should be stored');
    logger.success('Encoded doc_id stored correctly');
  });

  // Test 18: Verify fileref updated in XML content of all TEI files
  test('PATCH /api/v1/files/{stable_id}/doc-id should update fileref in all TEI XML files', async () => {
    // First update doc_id to a new value
    const newDocId = `test-fileref-update-${testRunId}`;

    await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${testState.versionStableId}/doc-id`,
      'PATCH',
      { doc_id: newDocId },
      BASE_URL
    );

    logger.success('Updated doc_id to trigger fileref update');

    // Get list of all files to find all TEI files with this doc_id
    const listData = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    // Find the document with our new doc_id
    const document = listData.files.find(doc => doc.doc_id === newDocId);
    assert.ok(document, `Should find document with doc_id ${newDocId}`);

    // Collect all TEI file IDs (source + artifacts)
    const teiFileIds = [];
    if (document.source?.file_type === 'tei') {
      teiFileIds.push(document.source.id);
    }
    if (document.artifacts) {
      document.artifacts
        .filter(a => a.file_type === 'tei')
        .forEach(a => teiFileIds.push(a.id));
    }

    assert.ok(teiFileIds.length > 0, 'Should have at least one TEI file to verify');
    logger.success(`Found ${teiFileIds.length} TEI file(s) to verify`);

    // Fetch and verify XML content for each TEI file
    for (const fileId of teiFileIds) {
      const xmlResponse = await authenticatedApiCall(
        reviewerSession.sessionId,
        `/files/${fileId}`,
        'GET',
        null,
        BASE_URL
      );

      // The response should be XML text
      assert.ok(xmlResponse, `Should have XML content for ${fileId}`);

      // Parse XML to verify fileref
      const filerefMatch = xmlResponse.match(/<idno[^>]*type="fileref"[^>]*>([^<]+)<\/idno>/);
      assert.ok(filerefMatch, `Should find fileref element in XML for ${fileId}`);

      const filerefValue = filerefMatch[1];
      assert.strictEqual(
        filerefValue,
        newDocId,
        `Fileref in ${fileId} should be updated to ${newDocId}, got ${filerefValue}`
      );

      logger.success(`Verified fileref in ${fileId}: ${filerefValue}`);
    }

    logger.success('All TEI files have updated fileref values');
  });
});

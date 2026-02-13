/**
 * E2E Backend Tests for Files Save API
 * @testCovers fastapi_app/routers/files_save.py
 * @testCovers fastapi_app/lib/file_repository.py
 *
 * Tests cover:
 * - First-time file save (creates new gold standard)
 * - Update existing file (content changes)
 * - Update existing file (no content changes, metadata only)
 * - Create new version from existing file
 * - Create new version from gold standard
 * - Permission checks (reviewer vs annotator)
 * - Variant handling
 * - File ID resolution (stable_id vs content hash)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Sample TEI XML templates
const createTeiXml = (docId, content, variant = null) => {
  const variantLabel = variant ? `<label type="variant-id">${variant}</label>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document ${docId}</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>Original Edition</title>
          <idno type="fileref">${docId}</idno>
        </edition>
      </editionStmt>
      <publicationStmt>
        <p>Test publication</p>
      </publicationStmt>
      <sourceDesc>
        <p>Test source</p>
        <application type="extractor">
          ${variantLabel}
        </application>
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

// TEI XML with full metadata for PDF update tests
const createTeiXmlWithMetadata = (docId, variant = null) => {
  const variantLabel = variant ? `<label type="variant-id">${variant}</label>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title level="a">Machine Learning in Digital Humanities</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>Test Edition</title>
          <idno type="fileref">${docId}</idno>
        </edition>
      </editionStmt>
      <publicationStmt>
        <publisher>Academic Press</publisher>
        <date type="publication">2023</date>
        <idno type="DOI">10.1234/ml.dh.2023</idno>
      </publicationStmt>
      <sourceDesc>
        <biblStruct>
          <analytic>
            <title level="a">Machine Learning in Digital Humanities</title>
            <author>
              <persName>
                <forename>Jane</forename>
                <surname>Smith</surname>
              </persName>
            </author>
          </analytic>
          <monogr>
            <title level="j">Digital Humanities Quarterly</title>
            <imprint>
              <publisher>Academic Press</publisher>
              <date when="2023">2023</date>
            </imprint>
          </monogr>
        </biblStruct>
      </sourceDesc>
    </fileDesc>
    <encodingDesc>
      <appInfo>
        <application version="0.7.1" ident="GROBID" type="extractor">
          ${variantLabel}
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <p>Sample content for metadata testing</p>
      </div>
    </body>
  </text>
</TEI>`;
};

describe('Files Save API E2E Tests', () => {
  let reviewerSession = null;
  let annotatorSession = null;
  const testRunId = Math.random().toString(36).substring(2, 15);

  // Shared test state
  const testState = {
    docId: `test-save-${testRunId}`,
    goldFileId: null,
    versionFileId: null,
    variantGoldFileId: null,
  };

  // Setup: Login sessions
  test('Setup: login as reviewer', async () => {
    reviewerSession = await login('reviewer', 'reviewer', BASE_URL);
    assert.ok(reviewerSession?.sessionId, 'Should have reviewer session');
    logger.success('Reviewer session created');
  });

  test('Setup: login as annotator', async () => {
    annotatorSession = await login('annotator', 'annotator', BASE_URL);
    assert.ok(annotatorSession?.sessionId, 'Should have annotator session');
    logger.success('Annotator session created');
  });

  // Test 1: First save creates new gold standard file
  test('POST /api/files/save should create new gold standard file on first save', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Initial content for gold standard');

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
    assert.strictEqual(response.status, 'new_gold', 'Should return new_gold status');
    assert.ok(response.file_id, 'Should return file_id');
    assert.match(response.file_id, /^[a-z0-9]{6,}$/, 'file_id should be stable ID format');

    testState.goldFileId = response.file_id;
    logger.success(`Created gold standard file: ${testState.goldFileId}`);

    // Release lock for future tests
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 2: Annotator cannot create gold standard
  test('POST /api/files/save should reject gold standard creation by annotator', async () => {
    const docId = `${testState.docId}-annotator-gold`;
    const xmlContent = createTeiXml(docId, 'Annotator trying to create gold');

    try {
      await authenticatedApiCall(
        annotatorSession.sessionId,
        '/files/save',
        'POST',
        {
          file_id: docId,
          xml_string: xmlContent,
          new_version: false
        },
        BASE_URL
      );
      assert.fail('Should have rejected annotator creating gold standard');
    } catch (error) {
      assert.match(
        error.message,
        /Only reviewers can create new gold standard files|403/i,
        'Should reject with permission error'
      );
      logger.success('Correctly rejected annotator creating gold standard');
    }
  });

  // Test 3: Update existing gold standard file (content changes)
  test('POST /api/files/save should update gold standard with content changes', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Updated content for gold standard');

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId,
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should return saved status');
    assert.ok(response.file_id, 'Should return file_id');
    // Stable ID should remain the same even though content hash changed
    assert.strictEqual(response.file_id, testState.goldFileId, 'Stable ID should remain unchanged');

    logger.success(`Updated gold standard file: ${response.file_id}`);

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 4: Update existing file with no content changes (metadata only)
  test('POST /api/files/save should handle save with no content changes', async () => {
    // Save the exact same content again
    const xmlContent = createTeiXml(testState.docId, 'Updated content for gold standard');

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId,
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should return saved status');
    assert.strictEqual(response.file_id, testState.goldFileId, 'Should return same file_id');

    logger.success('Handled no-content-change save correctly');

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 5: Annotator cannot edit gold standard
  test('POST /api/files/save should reject gold standard edit by annotator', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Annotator trying to edit gold');

    try {
      await authenticatedApiCall(
        annotatorSession.sessionId,
        '/files/save',
        'POST',
        {
          file_id: testState.goldFileId,
          xml_string: xmlContent,
          new_version: false
        },
        BASE_URL
      );
      assert.fail('Should have rejected annotator editing gold standard');
    } catch (error) {
      assert.match(
        error.message,
        /Only reviewers can edit gold standard files|403/i,
        'Should reject with permission error'
      );
      logger.success('Correctly rejected annotator editing gold standard');
    }
  });

  // Test 6: Create new version (annotator)
  test('POST /api/files/save should create new version (annotator)', async () => {
    const xmlContent = createTeiXml(testState.docId, 'First version by annotator');

    const response = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId,
        xml_string: xmlContent,
        new_version: true
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'new', 'Should return new status');
    assert.ok(response.file_id, 'Should return file_id');
    assert.notStrictEqual(response.file_id, testState.goldFileId, 'Should have different file_id than gold');

    testState.versionFileId = response.file_id;
    logger.success(`Created version file: ${testState.versionFileId}`);

    // Release lock
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 7: Update existing version
  test('POST /api/files/save should update existing version', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Updated version content');

    const response = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.versionFileId,
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should return saved status');
    assert.strictEqual(response.file_id, testState.versionFileId, 'Should return same stable ID');

    logger.success(`Updated version file: ${response.file_id}`);

    // Release lock
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 8: Create second version (increments version number)
  test('POST /api/files/save should create second version with incremented version number', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Second version content');

    const response = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId, // Base on gold, not first version
        xml_string: xmlContent,
        new_version: true
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'new', 'Should return new status');
    assert.ok(response.file_id, 'Should return file_id');
    assert.notStrictEqual(response.file_id, testState.versionFileId, 'Should be different from first version');

    logger.success(`Created second version: ${response.file_id}`);

    // Release lock
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 9: Variant handling - create gold with variant
  test('POST /api/files/save should create gold standard with variant', async () => {
    const variantDocId = `${testState.docId}-variant`;
    const xmlContent = createTeiXml(variantDocId, 'Content with variant', 'grobid.training');

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: variantDocId,
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'new_gold', 'Should create new gold with variant');
    assert.ok(response.file_id, 'Should return file_id');

    testState.variantGoldFileId = response.file_id;
    logger.success(`Created variant gold standard: ${testState.variantGoldFileId}`);

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 10: Create version from variant gold
  test('POST /api/files/save should create version from variant gold', async () => {
    const variantDocId = `${testState.docId}-variant`;
    const xmlContent = createTeiXml(variantDocId, 'First version of variant', 'grobid.training');

    const response = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.variantGoldFileId,
        xml_string: xmlContent,
        new_version: true
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'new', 'Should create new version');
    assert.ok(response.file_id, 'Should return file_id');
    assert.notStrictEqual(response.file_id, testState.variantGoldFileId, 'Should differ from variant gold');

    logger.success(`Created variant version: ${response.file_id}`);

    // Release lock
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 11: Stable ID resolution (using stable_id instead of content hash)
  test('POST /api/files/save should resolve stable_id to file', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Content updated via stable ID');

    // Use the stable ID (short form) instead of content hash
    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId, // This is the stable_id
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should update file');
    assert.strictEqual(response.file_id, testState.goldFileId, 'Should return same stable_id');

    logger.success('Stable ID resolution works correctly');

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 12: Abbreviated stable ID resolution
  test('POST /api/files/save should resolve abbreviated stable_id', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Content updated via abbreviated ID');

    // Use abbreviated stable ID (first 6 characters)
    const abbreviatedId = testState.goldFileId.substring(0, 6);

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: abbreviatedId,
        xml_string: xmlContent,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should update file');
    assert.strictEqual(response.file_id, testState.goldFileId, 'Should return full stable_id');

    logger.success(`Abbreviated ID ${abbreviatedId} resolved correctly`);

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 13: Invalid XML rejection
  test('POST /api/files/save should reject invalid XML', async () => {
    const invalidXml = '<not-valid-xml>';

    try {
      await authenticatedApiCall(
        reviewerSession.sessionId,
        '/files/save',
        'POST',
        {
          file_id: testState.docId,
          xml_string: invalidXml,
          new_version: false
        },
        BASE_URL
      );
      assert.fail('Should have rejected invalid XML');
    } catch (error) {
      assert.match(
        error.message,
        /Invalid XML|400/i,
        'Should reject with validation error'
      );
      logger.success('Correctly rejected invalid XML');
    }
  });

  // Test 14: Base64 encoding support
  test('POST /api/files/save should support base64 encoded XML', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Base64 encoded content');
    const base64Content = Buffer.from(xmlContent).toString('base64');

    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId,
        xml_string: base64Content,
        encoding: 'base64',
        new_version: false
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive response');
    assert.strictEqual(response.status, 'saved', 'Should save base64 content');
    assert.ok(response.file_id, 'Should return file_id');

    logger.success('Base64 encoding support works');

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response.file_id },
      BASE_URL
    );
  });

  // Test 15: Duplicate content handling (same content gets same hash)
  test('POST /api/files/save should handle duplicate content efficiently', async () => {
    const xmlContent = createTeiXml(testState.docId, 'Duplicate content test');

    // First save
    const response1 = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId,
        xml_string: xmlContent,
        new_version: true
      },
      BASE_URL
    );

    assert.ok(response1.file_id, 'First save should succeed');
    const firstFileId = response1.file_id;

    // Release lock
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: firstFileId },
      BASE_URL
    );

    // Second save with identical content (should create new version but detect existing hash)
    const response2 = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.goldFileId,
        xml_string: xmlContent,
        new_version: true
      },
      BASE_URL
    );

    assert.ok(response2.file_id, 'Second save should succeed');
    // Content-addressed storage means same content might return existing file
    logger.success(`Duplicate content handled: ${response2.status}`);

    // Release lock
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: response2.file_id },
      BASE_URL
    );
  });

  // Test: PDF metadata updates when saving gold standard TEI
  test('POST /api/files/save should update PDF metadata when saving gold standard TEI with full metadata', async () => {
    const metadataTestDocId = `test-pdf-metadata-${testRunId}`;

    // First, upload a PDF file using the upload endpoint
    const pdfContent = Buffer.from('%PDF-1.4 fake pdf content for metadata test');
    const formData = new FormData();
    formData.append('file', new Blob([pdfContent], { type: 'application/pdf' }), `${metadataTestDocId}.pdf`);

    const uploadResponse = await fetch(`${BASE_URL}/api/v1/files/upload`, {
      method: 'POST',
      headers: {
        'X-Session-ID': reviewerSession.sessionId
      },
      body: formData
    });

    assert.ok(uploadResponse.ok, 'PDF upload should succeed');
    const uploadResult = await uploadResponse.json();
    const pdfFileId = uploadResult.filename; // filename contains stable_id
    logger.info(`Uploaded PDF with stable_id: ${pdfFileId}`);

    // Get initial PDF metadata (should have no label or doc_metadata)
    const initialMetadataResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${pdfFileId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    logger.info(`Initial PDF metadata: label="${initialMetadataResponse.label}", has doc_metadata=${!!initialMetadataResponse.doc_metadata}`);

    // Now save a gold standard TEI with full metadata
    const teiXml = createTeiXmlWithMetadata(metadataTestDocId, 'grobid-segmentation');

    const saveResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: metadataTestDocId,
        xml_string: teiXml,
        new_version: false
      },
      BASE_URL
    );

    assert.ok(saveResponse, 'Should save TEI file');
    assert.strictEqual(saveResponse.status, 'new_gold', 'Should create new gold standard');
    const teiFileId = saveResponse.file_id;
    logger.success(`Created gold TEI with file_id: ${teiFileId}`);

    // Get updated PDF metadata
    const updatedMetadataResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${pdfFileId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    // Verify PDF metadata was updated
    assert.ok(updatedMetadataResponse.label, 'PDF should have a label after TEI save');
    assert.strictEqual(
      updatedMetadataResponse.label,
      'Smith (2023) Machine Learning in Digital Humanities',
      'PDF label should be formatted as "Author (Year) Title"'
    );

    assert.ok(updatedMetadataResponse.doc_metadata, 'PDF should have doc_metadata');
    assert.strictEqual(
      updatedMetadataResponse.doc_metadata.title,
      'Machine Learning in Digital Humanities',
      'PDF doc_metadata should include title'
    );
    assert.strictEqual(
      updatedMetadataResponse.doc_metadata.date,
      '2023',
      'PDF doc_metadata should include date'
    );
    assert.strictEqual(
      updatedMetadataResponse.doc_metadata.publisher,
      'Academic Press',
      'PDF doc_metadata should include publisher'
    );

    logger.success('PDF metadata correctly updated from gold TEI');

    // Cleanup
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: teiFileId },
      BASE_URL
    );

    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/delete',
      'POST',
      { files: [teiFileId, pdfFileId] },
      BASE_URL
    );
  });

  // Test: Version files should NOT update PDF metadata
  test('POST /api/files/save should NOT update PDF metadata when saving version (non-gold) TEI', async () => {
    const versionTestDocId = `test-version-no-update-${testRunId}`;

    // Upload PDF
    const pdfContent = Buffer.from('%PDF-1.4 fake pdf for version test');
    const formData = new FormData();
    formData.append('file', new Blob([pdfContent], { type: 'application/pdf' }), `${versionTestDocId}.pdf`);

    const uploadResponse = await fetch(`${BASE_URL}/api/v1/files/upload`, {
      method: 'POST',
      headers: {
        'X-Session-ID': reviewerSession.sessionId
      },
      body: formData
    });

    const uploadResult = await uploadResponse.json();
    const pdfFileId = uploadResult.filename; // filename contains stable_id

    // Create gold standard first with basic metadata
    const goldTeiXml = createTeiXml(versionTestDocId, 'Gold content');
    const goldSaveResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: versionTestDocId,
        xml_string: goldTeiXml,
        new_version: false
      },
      BASE_URL
    );

    const goldFileId = goldSaveResponse.file_id;

    // Release lock on gold file
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: goldFileId },
      BASE_URL
    );

    // Get PDF metadata after gold save
    const afterGoldMetadata = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${pdfFileId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    const goldLabel = afterGoldMetadata.label;
    logger.info(`PDF label after gold save: "${goldLabel}"`);

    // Now create a version with DIFFERENT metadata (as annotator)
    const versionTeiXml = createTeiXmlWithMetadata(versionTestDocId);
    const versionSaveResponse = await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: versionTestDocId,
        xml_string: versionTeiXml,
        new_version: true
      },
      BASE_URL
    );

    assert.strictEqual(versionSaveResponse.status, 'new', 'Should create new version');
    const versionFileId = versionSaveResponse.file_id;
    logger.info(`Created version TEI with file_id: ${versionFileId}`);

    // Get PDF metadata after version save
    const afterVersionMetadata = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${pdfFileId}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    // Verify PDF metadata was NOT changed by version save
    assert.strictEqual(
      afterVersionMetadata.label,
      goldLabel,
      'PDF label should NOT change when saving version TEI'
    );

    // The metadata should NOT have been updated with the version's metadata
    if (afterVersionMetadata.doc_metadata) {
      assert.notStrictEqual(
        afterVersionMetadata.doc_metadata.title,
        'Machine Learning in Digital Humanities',
        'PDF metadata should NOT be updated from version TEI'
      );
    }

    logger.success('PDF metadata correctly NOT updated from version TEI');

    // Cleanup
    await authenticatedApiCall(
      annotatorSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: versionFileId },
      BASE_URL
    );

    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/delete',
      'POST',
      { files: [goldFileId, versionFileId, pdfFileId] },
      BASE_URL
    );
  });

  // Cleanup: Release all locks and delete test files
  test('Cleanup: delete test files', async () => {
    const filesToDelete = [
      testState.goldFileId,
      testState.versionFileId,
      testState.variantGoldFileId,
    ].filter(Boolean);

    if (filesToDelete.length > 0) {
      try {
        await authenticatedApiCall(
          reviewerSession.sessionId,
          '/files/delete',
          'POST',
          { files: filesToDelete },
          BASE_URL
        );
        logger.success(`Cleaned up ${filesToDelete.length} test files`);
      } catch (error) {
        logger.warn(`Cleanup error (non-critical): ${error.message}`);
      }
    }
  });
});

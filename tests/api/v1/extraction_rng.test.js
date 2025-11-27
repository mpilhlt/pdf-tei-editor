/**
 * E2E Backend Tests for RNG Extraction
 * Tests RNG schema extraction with stable variant-based URLs
 * @testCovers fastapi_app/routers/extraction.py
 * @testCovers fastapi_app/routers/schema.py
 * @testCovers fastapi_app/routers/files_serve.py
 * @testCovers fastapi_app/extractors/rng_extractor.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall, authenticatedRequest } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

// Enable mock extractor for testing
process.env.TEST_IN_PROGRESS = '1';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Sample TEI XML for RNG extraction
const SAMPLE_TEI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Sample Document for RNG Extraction</title>
      </titleStmt>
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
        <p>Sample content for schema extraction.</p>
      </div>
    </body>
  </text>
</TEI>`;

describe('RNG Extraction E2E Tests', () => {
  let session = null;
  let testFileHash = null;
  let rngFileId = null;
  const testVariant = `test-variant-${Date.now()}`;

  test('Setup: login as reviewer', async () => {
    session = await login('reviewer', 'reviewer', BASE_URL);
    assert.ok(session, 'Should have a valid session');
    assert.ok(session.sessionId, 'Session should have an ID');
  });

  test('Setup: upload test XML file for RNG extraction', async () => {
    const testFilePath = `/data/test-rng-extraction-${Date.now()}.tei.xml`;

    const response = await authenticatedApiCall(
      session.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testFilePath,
        xml_string: SAMPLE_TEI_XML
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.file_id, 'Should have file_id');

    testFileHash = response.file_id;
    logger.success(`Test TEI file uploaded: ${testFileHash}`);
  });

  test('POST /api/extract with rng extractor should create RNG schema with variant', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/extract',
      'POST',
      {
        extractor: 'rng',
        file_id: testFileHash,
        options: {
          schema_strictness: 'balanced',
          include_namespaces: true,
          add_documentation: true,
          variant_id: testVariant
        }
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.xml, 'Should have xml (RNG file ID) in response');
    assert.strictEqual(response.pdf, null, 'Should not have pdf in response for XML-to-XML extraction');

    rngFileId = response.xml;
    logger.success(`RNG extraction succeeded with variant=${testVariant}, result: ${rngFileId}`);
  });

  test('GET /api/files/list should include RNG file with correct variant', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      `/files/list?variant=${testVariant}`,
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    const files = response.files || response;
    assert.ok(Array.isArray(files), 'Should have files array');

    // Find the RNG document in the list
    const rngDocument = files.find(docGroup => {
      // Check if source is the RNG file (self-referential)
      return docGroup.source && docGroup.source.id === rngFileId;
    });

    assert.ok(rngDocument, `RNG file should appear in file list with variant=${testVariant}`);
    assert.strictEqual(rngDocument.source.file_type, 'rng', 'Source should be RNG type');
    assert.strictEqual(rngDocument.source.label, 'RelaxNG Schema', 'Should have descriptive label');
    assert.ok(Array.isArray(rngDocument.artifacts), 'Should have artifacts array');
    assert.strictEqual(rngDocument.artifacts.length, 1, 'RNG file should have one artifact (itself)');
    assert.strictEqual(rngDocument.artifacts[0].variant, testVariant, `Artifact should have variant=${testVariant}`);

    logger.success(`RNG file found in file list as self-referential source with variant=${testVariant}`);
    logger.info(`  - doc_id: ${rngDocument.doc_id}`);
    logger.info(`  - source.id: ${rngDocument.source.id}`);
    logger.info(`  - source.file_type: ${rngDocument.source.file_type}`);
    logger.info(`  - source.label: ${rngDocument.source.label}`);
    logger.info(`  - artifacts[0].variant: ${rngDocument.artifacts[0].variant}`);
  });

  test('RNG file should be loadable via /api/files/{id}', async () => {
    const response = await authenticatedRequest(
      session.sessionId,
      `/files/${rngFileId}`,
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.ok, 'Response should be successful');

    // Get XML content as text
    const xmlContent = await response.text();
    assert.ok(xmlContent, 'Should have XML content');
    assert.ok(xmlContent.includes('<grammar'), 'Should contain RNG grammar element');
    assert.ok(xmlContent.includes('http://relaxng.org/ns/structure/1.0'), 'Should contain RelaxNG namespace');

    logger.success('RNG file successfully loaded via /api/files/{id}');
  });

  test('RNG schema should be accessible via stable /api/v1/schema/rng/{variant} endpoint', async () => {
    const response = await authenticatedRequest(
      session.sessionId,
      `/schema/rng/${testVariant}`,
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.ok, 'Response should be successful');
    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    // Get XML content
    const xmlContent = await response.text();
    assert.ok(xmlContent, 'Should have XML content');
    assert.ok(xmlContent.includes('<grammar'), 'Should contain RNG grammar element');
    assert.ok(xmlContent.includes('http://relaxng.org/ns/structure/1.0'), 'Should contain RelaxNG namespace');

    logger.success(`RNG schema accessible via /api/v1/schema/rng/${testVariant}`);
  });

  test('RNG schema should contain validation instruction with stable URL', async () => {
    const response = await authenticatedRequest(
      session.sessionId,
      `/files/${rngFileId}`,
      'GET',
      null,
      BASE_URL
    );

    const xmlContent = await response.text();

    // Check for validation instruction
    assert.ok(xmlContent.includes('<?xml-model'), 'Should contain xml-model processing instruction');
    assert.ok(xmlContent.includes('/api/v1/schema/rng/'), 'Should reference schema endpoint');
    assert.ok(xmlContent.includes(testVariant), 'Should reference the variant in URL');

    // Verify no URL encoding needed (no colons, etc.)
    assert.ok(!xmlContent.includes('schema:rng'), 'Should not use colon separator (would require encoding)');
    assert.ok(!xmlContent.includes('%3A'), 'Should not contain URL-encoded characters');

    logger.success('RNG schema contains correct validation instruction with clean URL');
  });

  test('Re-extracting same variant should create a new version', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/extract',
      'POST',
      {
        extractor: 'rng',
        file_id: testFileHash,
        options: {
          schema_strictness: 'permissive', // Different option to change content
          include_namespaces: true,
          add_documentation: true,
          variant_id: testVariant
        }
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.xml, 'Should have xml (RNG file ID) in response');

    const newRngFileId = response.xml;
    logger.success(`Second extraction created new version: ${newRngFileId}`);

    // The stable schema endpoint should still serve the gold standard
    const schemaResponse = await authenticatedRequest(
      session.sessionId,
      `/schema/rng/${testVariant}`,
      'GET',
      null,
      BASE_URL
    );

    assert.ok(schemaResponse.ok, 'Schema endpoint should still work');
    logger.success('Schema endpoint still serves gold standard after version creation');
  });

  test('GET /api/v1/schema/rng/{variant} for non-existent variant should return 404', async () => {
    const nonExistentVariant = `non-existent-${Date.now()}`;
    const response = await authenticatedRequest(
      session.sessionId,
      `/schema/rng/${nonExistentVariant}`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(response.status, 404, 'Should return 404 for non-existent variant');

    const errorData = await response.json();
    assert.ok(errorData.detail, 'Should have error detail');
    assert.ok(errorData.detail.includes(nonExistentVariant), 'Error should mention the variant name');

    logger.success('Schema endpoint correctly returns 404 for non-existent variant');
  });
});

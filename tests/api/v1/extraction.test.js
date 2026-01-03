/**
 * E2E Backend Tests for Extraction API
 * @testCovers fastapi_app/routers/extraction.py
 * @testCovers fastapi_app/lib/extractor_manager.py
 * 
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

// Enable mock extractor for testing
process.env.TEST_IN_PROGRESS = '1';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Sample TEI XML for XML-based extraction
const SAMPLE_TEI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Sample Document for Extraction Test</title>
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
        <p>Sample content for extraction testing.</p>
      </div>
    </body>
  </text>
</TEI>`;

describe('Extraction API E2E Tests', () => {
  let session = null;
  let testFileHash = null;

  // Login once for all tests - use reviewer to be able to save files
  test('Setup: login as reviewer', async () => {
    session = await login('reviewer', 'reviewer', BASE_URL);
    assert.ok(session, 'Should have a valid session');
    assert.ok(session.sessionId, 'Session should have an ID');
  });

  test('Setup: upload test XML file for extraction', async () => {
    // Save a test TEI file to use for extraction
    const testFilePath = `/data/test-extraction-${Date.now()}.tei.xml`;

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
    logger.success(`Test file uploaded: ${testFileHash}`);
  });

  test('GET /api/extract/list should return available extractors', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/extract/list',
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(Array.isArray(response.extractors) || Array.isArray(response),
      'Should have extractors array');

    const extractors = response.extractors || response;
    assert.ok(extractors.length > 0, 'Should have at least one extractor');

    // Check extractor structure
    const firstExtractor = extractors[0];
    assert.ok(firstExtractor.id, 'Extractor should have id');
    assert.ok(firstExtractor.name, 'Extractor should have name');
    assert.ok(firstExtractor.description, 'Extractor should have description');
    assert.ok(Array.isArray(firstExtractor.input), 'Extractor should have input array');
    assert.ok(Array.isArray(firstExtractor.output), 'Extractor should have output array');
    assert.ok(typeof firstExtractor.available === 'boolean', 'Extractor should have available flag');

    logger.success(`Found ${extractors.length} available extractors:`);
    extractors.forEach(ext => {
      logger.info(`  - ${ext.id}: ${ext.name} (${ext.input.join(', ')} → ${ext.output.join(', ')})`);
    });
  });

  test('POST /api/extract should reject missing extractor parameter', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/extract',
        'POST',
        {
          file_id: testFileHash,
          options: {}
        },
        BASE_URL
      );
      assert.fail('Should have thrown an error for missing extractor');
    } catch (error) {
      assert.ok(
        error.message.includes('400') || error.message.includes('422'),
        'Should return 400 or 422 for missing extractor'
      );
      logger.success('Rejected request with missing extractor');
    }
  });

  test('POST /api/extract should reject unknown extractor', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/extract',
        'POST',
        {
          extractor: 'unknown-extractor-xyz',
          file_id: testFileHash,
          options: {}
        },
        BASE_URL
      );
      assert.fail('Should have thrown an error for unknown extractor');
    } catch (error) {
      assert.ok(error.message.includes('400'), 'Should return 400 for unknown extractor');
      assert.ok(error.message.includes('Unknown extractor'), 'Error should mention unknown extractor');
      logger.success('Rejected request with unknown extractor');
    }
  });

  test('POST /api/extract should reject missing file_id', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/extract',
        'POST',
        {
          extractor: 'mock-extractor',
          options: {}
        },
        BASE_URL
      );
      assert.fail('Should have thrown an error for missing file_id');
    } catch (error) {
      assert.ok(
        error.message.includes('400') || error.message.includes('422'),
        'Should return 400 or 422 for missing file_id'
      );
      logger.success('Rejected request with missing file_id');
    }
  });

  test('POST /api/extract should reject non-existent file_id', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/extract',
        'POST',
        {
          extractor: 'mock-extractor',
          file_id: 'nonexistent-file-hash-12345',
          options: {}
        },
        BASE_URL
      );
      assert.fail('Should have thrown an error for non-existent file');
    } catch (error) {
      assert.ok(error.message.includes('404'), 'Should return 404 for non-existent file');
      logger.success('Rejected request with non-existent file_id');
    }
  });

  test('POST /api/extract with mock extractor should perform extraction', async () => {
    // Use mock extractor which accepts PDF or XML input
    const response = await authenticatedApiCall(
      session.sessionId,
      '/extract',
      'POST',
      {
        extractor: 'mock-extractor',
        file_id: testFileHash,
        options: {
          doi: '10.1234/test.doi'
        }
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.xml, 'Should have xml hash in response');

    logger.success(`Mock extraction succeeded, result: ${response.xml}`);

    // Verify the extracted file was saved
    const filesResponse = await authenticatedApiCall(
      session.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const files = filesResponse.files || filesResponse;

    // Search for extracted file in artifacts array (new structure)
    let extractedFile = null;
    for (const docGroup of files) {
      // Check in artifacts (new structure)
      if (docGroup.artifacts) {
        extractedFile = docGroup.artifacts.find(artifact =>
          artifact.id === response.xml || artifact.filename?.includes(response.xml)
        );
      }
      if (extractedFile) break;
    }

    if (extractedFile) {
      logger.success('Extracted file found in file list');
      assert.ok(extractedFile.file_type === 'tei',
        'Extracted file should be TEI type');
    } else {
      logger.warn('Extracted file not found in list (hash mismatch or async issue)');
    }
  });

  test('POST /api/extract should assign PDF and TEI to specified collection', async () => {
    // Login as admin to access metadata endpoint
    const adminSession = await login('admin', 'admin', BASE_URL);
    assert.ok(adminSession, 'Should have admin session');

    // First upload a PDF file
    const pdfContent = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n/Contents 4 0 R\n>>\nendobj\n4 0 obj\n<<\n/Length 44\n>>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Test PDF) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\n0000000214 00000 n\ntrailer\n<<\n/Size 5\n/Root 1 0 R\n>>\nstartxref\n307\n%%EOF');

    // Upload PDF
    const uploadResponse = await fetch(`${BASE_URL}/api/v1/files/upload`, {
      method: 'POST',
      headers: {
        'X-Session-ID': adminSession.sessionId
      },
      body: (() => {
        const formData = new FormData();
        const blob = new Blob([pdfContent], { type: 'application/pdf' });
        formData.append('file', blob, 'test-extraction.pdf');
        return formData;
      })()
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      assert.fail(`PDF upload failed with status ${uploadResponse.status}: ${errorText}`);
    }
    const uploadData = await uploadResponse.json();
    const pdfStableId = uploadData.filename;

    logger.success(`Uploaded PDF: ${pdfStableId}`);

    // Extract with specific collection
    const extractResponse = await authenticatedApiCall(
      adminSession.sessionId,
      '/extract',
      'POST',
      {
        extractor: 'mock-extractor',
        file_id: pdfStableId,
        options: {
          collection: 'test_collection',
          doi: '10.1234/test.collection'
        }
      },
      BASE_URL
    );

    assert.ok(extractResponse, 'Should receive extraction response');
    assert.ok(extractResponse.xml, 'Should have xml hash in response');
    assert.ok(extractResponse.pdf, 'Should have pdf stable_id in response');

    logger.success(`Extraction completed, TEI: ${extractResponse.xml}, PDF: ${extractResponse.pdf}`);

    // Get file metadata for both PDF and TEI using admin-only metadata endpoint
    const pdfDetailsResponse = await authenticatedApiCall(
      adminSession.sessionId,
      `/files/${extractResponse.pdf}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    const teiDetailsResponse = await authenticatedApiCall(
      adminSession.sessionId,
      `/files/${extractResponse.xml}/metadata`,
      'GET',
      null,
      BASE_URL
    );

    // Verify both files are in the correct collection
    assert.ok(pdfDetailsResponse.doc_collections, 'PDF should have doc_collections');
    assert.ok(pdfDetailsResponse.doc_collections.includes('test_collection'),
      `PDF should be in test_collection, got: ${JSON.stringify(pdfDetailsResponse.doc_collections)}`);

    assert.ok(teiDetailsResponse.doc_collections, 'TEI should have doc_collections');
    assert.ok(teiDetailsResponse.doc_collections.includes('test_collection'),
      `TEI should be in test_collection, got: ${JSON.stringify(teiDetailsResponse.doc_collections)}`);

    logger.success('Both PDF and TEI files are in the correct collection');
  });

});

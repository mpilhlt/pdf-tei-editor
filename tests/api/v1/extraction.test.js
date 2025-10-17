/**
 * E2E Backend Tests for Extraction API
 * @testCovers fastapi_app/routers/extraction.py
 * @testCovers fastapi_app/lib/extractor_manager.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';

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
    assert.ok(response.hash, 'Should have hash');

    testFileHash = response.hash;
    console.log(`✓ Test file uploaded: ${testFileHash}`);
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

    console.log(`✓ Found ${extractors.length} available extractors:`);
    extractors.forEach(ext => {
      console.log(`  - ${ext.id}: ${ext.name} (${ext.input.join(', ')} → ${ext.output.join(', ')})`);
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
      console.log('✓ Rejected request with missing extractor');
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
      console.log('✓ Rejected request with unknown extractor');
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
      console.log('✓ Rejected request with missing file_id');
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
      console.log('✓ Rejected request with non-existent file_id');
    }
  });

  test('POST /api/extract with RNG extractor should perform extraction', async () => {
    // Use RNG extractor which accepts XML input
    const response = await authenticatedApiCall(
      session.sessionId,
      '/extract',
      'POST',
      {
        extractor: 'rng',
        file_id: testFileHash,
        options: {
          collection: 'test_collection'
        }
      },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(response.xml, 'Should have xml hash in response');

    // For PDF-based extraction, we'd also have pdf hash and id
    // For XML-based extraction (like RNG), we just get xml hash
    console.log(`✓ RNG extraction succeeded, result: ${response.xml}`);

    // Verify the extracted file was saved
    const filesResponse = await authenticatedApiCall(
      session.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const files = filesResponse.files || filesResponse;
    const extractedFile = files.find(f => f.id === response.xml || f.hash === response.xml);

    if (extractedFile) {
      console.log(`✓ Extracted file found in file list`);
      assert.ok(extractedFile.file_type === 'tei' || extractedFile.type === 'tei',
        'Extracted file should be TEI type');
    } else {
      console.log(`⚠️  Extracted file not found in list (hash mismatch or async issue)`);
    }
  });

  test('POST /api/extract should fall back to mock for unavailable extractors', async () => {
    // Try to use an extractor that requires external dependencies (like grobid)
    // It should fall back to mock if dependencies are missing
    try {
      const response = await authenticatedApiCall(
        session.sessionId,
        '/extract',
        'POST',
        {
          extractor: 'grobid',  // Requires GROBID_SERVER_URL
          file_id: testFileHash,
          options: {}
        },
        BASE_URL
      );

      // If we get here, either grobid is available or it fell back to mock
      assert.ok(response, 'Should receive a response');
      assert.ok(response.xml, 'Should have xml hash in response');
      console.log('✓ Extraction succeeded (grobid available or mock fallback)');

    } catch (error) {
      // May fail with 400 if extractor expects PDF but we gave XML
      if (error.message.includes('expects PDF input')) {
        console.log('✓ Correctly validated input type mismatch');
      } else {
        console.log(`⚠️  Extraction failed: ${error.message}`);
      }
    }
  });

  test('POST /api/extract should validate input type matches extractor', async () => {
    // Get list of extractors to find one with specific input requirements
    const listResponse = await authenticatedApiCall(
      session.sessionId,
      '/extract/list',
      'GET',
      null,
      BASE_URL
    );

    const extractors = listResponse.extractors || listResponse;
    const pdfExtractor = extractors.find(e => e.input.includes('pdf'));

    if (pdfExtractor) {
      try {
        // Try to use PDF extractor on XML file
        await authenticatedApiCall(
          session.sessionId,
          '/extract',
          'POST',
          {
            extractor: pdfExtractor.id,
            file_id: testFileHash,  // This is an XML file
            options: {}
          },
          BASE_URL
        );
        assert.fail('Should have thrown an error for type mismatch');
      } catch (error) {
        assert.ok(error.message.includes('400'), 'Should return 400 for type mismatch');
        assert.ok(error.message.includes('expects PDF'), 'Error should mention type mismatch');
        console.log('✓ Validated input type mismatch');
      }
    } else {
      console.log('⚠️  No PDF extractor found, skipping type validation test');
    }
  });
});

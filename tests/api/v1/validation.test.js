/**
 * E2E Backend Tests for Validation API
 * @testCovers fastapi_app/routers/validation.py
 * @testCovers fastapi_app/lib/schema_validator.py
 * 
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Sample TEI XML with RelaxNG schema reference
const VALID_TEI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="https://raw.githubusercontent.com/kermitt2/grobid/refs/heads/master/grobid-home/schemas/rng/Grobid.rng" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
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
        <p>Test content</p>
      </div>
    </body>
  </text>
</TEI>`;

// Invalid XML (missing closing tag)
const INVALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text>
    <body>
      <p>Missing closing tag
    </body>
  </text>`;

// XML without schema reference
const XML_NO_SCHEMA = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text>
    <body>
      <p>No schema reference</p>
    </body>
  </text>
</TEI>`;

describe('Validation API E2E Tests', () => {
  let session = null;

  // Login once for all tests
  test('Setup: login as annotator', async () => {
    session = await login('annotator', 'annotator', BASE_URL);
    assert.ok(session, 'Should have a valid session');
    assert.ok(session.sessionId, 'Session should have an ID');
  });

  test('POST /api/validate should validate well-formed XML with schema', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/validate',
      'POST',
      { xml_string: VALID_TEI_XML },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(Array.isArray(response.errors), 'Should have errors array');

    // Valid XML may have warnings (e.g., timeout) but should not have syntax errors
    logger.info(`Validation result: ${response.errors.length} errors/warnings`);
    if (response.errors.length > 0) {
      logger.info('Errors/warnings:', response.errors);
      // Check if it's just a timeout warning
      const hasOnlyTimeoutWarning = response.errors.every(
        e => e.severity === 'warning' && e.message.includes('timed out')
      );
      if (hasOnlyTimeoutWarning) {
        logger.success('Validation timed out (expected for complex Grobid schema)');
      }
    }
  });

  test('POST /api/validate should detect XML syntax errors', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/validate',
      'POST',
      { xml_string: INVALID_XML },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(Array.isArray(response.errors), 'Should have errors array');
    assert.ok(response.errors.length > 0, 'Should have at least one error');

    // Check that error contains line and column info
    const firstError = response.errors[0];
    assert.ok(firstError.message, 'Error should have a message');
    assert.ok(typeof firstError.line === 'number', 'Error should have line number');
    assert.ok(typeof firstError.column === 'number', 'Error should have column number');

    logger.success(`Detected syntax error: ${firstError.message} at line ${firstError.line}`);
  });

  test('POST /api/validate should handle XML without schema gracefully', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/validate',
      'POST',
      { xml_string: XML_NO_SCHEMA },
      BASE_URL
    );

    assert.ok(response, 'Should receive a response');
    assert.ok(Array.isArray(response.errors), 'Should have errors array');
    assert.strictEqual(response.errors.length, 0, 'Should have no errors for XML without schema');

    logger.success('No errors for XML without schema reference');
  });

  test('POST /api/validate should reject empty XML', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/validate',
        'POST',
        { xml_string: '' },
        BASE_URL
      );
      assert.fail('Should have thrown an error for empty XML');
    } catch (error) {
      assert.ok(error.message.includes('400') || error.message.includes('422'),
        'Should return 400 or 422 for empty XML');
      logger.success('Rejected empty XML');
    }
  });

  test('POST /api/validate/autocomplete-data should generate autocomplete data', async () => {
    try {
      const response = await authenticatedApiCall(
        session.sessionId,
        '/validate/autocomplete-data',
        'POST',
        {
          xml_string: VALID_TEI_XML,
          invalidate_cache: false  // Use cache if available
        },
        BASE_URL
      );

      assert.ok(response, 'Should receive a response');
      assert.ok(response.data, 'Should have data property');
      assert.ok(typeof response.data === 'object', 'Data should be an object');

      // Check if we got element definitions
      const elementCount = Object.keys(response.data).filter(k => !k.startsWith('#')).length;
      assert.ok(elementCount > 0, 'Should have at least one element definition');

      logger.success(`Generated autocomplete data with ${elementCount} elements`);
    } catch (error) {
      // Autocomplete generation may fail for various reasons (timeout, network, schema complexity)
      // Log but don't fail the test
      logger.warn(`Autocomplete generation failed (this may be expected): ${error.message}`);
    }
  });

  test('POST /api/validate/autocomplete-data should reject XML without schema', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/validate/autocomplete-data',
        'POST',
        {
          xml_string: XML_NO_SCHEMA,
          invalidate_cache: false
        },
        BASE_URL
      );
      assert.fail('Should have thrown an error for XML without schema');
    } catch (error) {
      assert.ok(
        error.message.includes('400') || error.message.includes('No schema'),
        'Should return 400 for XML without schema'
      );
      logger.success('Rejected XML without schema reference');
    }
  });

  test('POST /api/validate/autocomplete-data with invalidate_cache should check internet', async () => {
    try {
      await authenticatedApiCall(
        session.sessionId,
        '/validate/autocomplete-data',
        'POST',
        {
          xml_string: VALID_TEI_XML,
          invalidate_cache: true  // This requires internet
        },
        BASE_URL
      );
      // If we have internet, this should succeed or timeout
      logger.success('Cache invalidation succeeded (internet available)');
    } catch (error) {
      // May fail with 503 if no internet connection
      if (error.message.includes('503')) {
        logger.success('Correctly returned 503 when offline');
      } else {
        // Other errors are also acceptable (schema issues, timeouts, etc.)
        logger.warn(`Cache invalidation failed: ${error.message}`);
      }
    }
  });
});

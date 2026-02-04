/**
 * Integration tests for KISSKI extraction API.
 *
 * Tests PDF upload and metadata extraction using the KISSKI LLM API.
 *
 * @testCovers fastapi_app/plugins/kisski/routes.py
 * @testCovers fastapi_app/plugins/kisski/extractor.py
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { login, logout } from '../../../../tests/api/helpers/test-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test PDF file
const TEST_PDF_PATH = join(__dirname, '10.21825__jeps.v4i1.10120.pdf');

// JSON schema for article metadata extraction
const METADATA_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Article title' },
    authors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          affiliation: { type: 'string' }
        },
        required: ['name']
      }
    },
    journal: { type: 'string', description: 'Journal name' },
    volume: { type: 'string', description: 'Volume number' },
    issue: { type: 'string', description: 'Issue number' },
    pages: { type: 'string', description: 'Page range (e.g., "1-15")' },
    year: { type: 'string', description: 'Publication year' },
    abstract: { type: 'string', description: 'Article abstract' }
  },
  required: ['title', 'authors', 'journal', 'year']
};

// Expected metadata for verification (verified from extraction run)
const EXPECTED_METADATA = {
  title: 'Citation Mining of Humanities Journals: The Progress to Date and the Challenges Ahead',
  authors: [
    { name: 'Giovanni Colavizza', affiliation: 'University of Amsterdam and École Polytechnique Fédérale de Lausanne' },
    { name: 'Matteo Romanello', affiliation: 'École Polytechnique Fédérale de Lausanne' }
  ],
  journal: 'Journal of European Periodical Studies',
  volume: '4.1',
  issue: 'Summer 2019',
  pages: '36–53',
  year: '2019',
  // Abstract key terms to check
  abstractContains: ['citation', 'humanities', 'bibliometric']
};

describe('KISSKI Extraction API', () => {
  let sessionId = null;
  let uploadedStableId = null;

  before(async () => {
    // Login to get session
    const loginResult = await login('admin', 'admin', BASE_URL);
    sessionId = loginResult.sessionId;
    assert.ok(sessionId, 'Should have session ID');
  });

  after(async () => {
    // Cleanup: logout
    if (sessionId) {
      await logout(sessionId, BASE_URL);
    }
  });

  test('should upload PDF file', async () => {
    // Read the test PDF
    const pdfContent = readFileSync(TEST_PDF_PATH);

    // Create form data for upload
    const formData = new FormData();
    const blob = new Blob([pdfContent], { type: 'application/pdf' });
    formData.append('file', blob, '10.21825__jeps.v4i1.10120.pdf');

    // Upload the file
    const response = await fetch(`${BASE_URL}/api/v1/files/upload`, {
      method: 'POST',
      headers: {
        'X-Session-Id': sessionId
      },
      body: formData
    });

    assert.strictEqual(response.status, 200, `Upload should succeed, got ${response.status}`);

    const result = await response.json();
    assert.strictEqual(result.type, 'pdf', 'Should be detected as PDF');
    assert.ok(result.filename, 'Should have filename (stable_id)');

    uploadedStableId = result.filename;
    console.log(`Uploaded PDF with stable_id: ${uploadedStableId}`);
  });

  let pdfSupport = false;

  test('should list available models', async () => {
    const response = await fetch(`${BASE_URL}/api/plugins/kisski/models`, {
      headers: {
        'X-Session-Id': sessionId
      }
    });

    assert.strictEqual(response.status, 200, 'Should get models list');

    const result = await response.json();
    assert.ok(Array.isArray(result.models), 'Should have models array');
    assert.ok(result.models.length > 0, 'Should have at least one model');

    // Store PDF support status for later tests
    pdfSupport = result.pdf_support;
    console.log(`PDF support available: ${pdfSupport}`);

    // Check for multimodal models (image support)
    const multimodalModels = result.models.filter(m =>
      m.input && m.input.includes('image')
    );
    console.log(`Found ${multimodalModels.length} multimodal models:`,
      multimodalModels.map(m => m.id).join(', '));

    assert.ok(multimodalModels.length > 0, 'Should have at least one multimodal model');
  });

  test('should extract article metadata from PDF', async (t) => {
    // Skip if no uploaded file
    if (!uploadedStableId) {
      t.skip('No uploaded file available');
      return;
    }

    // Skip if PDF support not available (poppler not installed)
    if (!pdfSupport) {
      t.skip('PDF support not available (install poppler: brew install poppler)');
      return;
    }

    // Use a multimodal model that supports images
    const model = 'gemma-3-27b-it';

    const extractRequest = {
      model,
      prompt: `Extract the article metadata from this academic paper PDF.
Include the title, authors (with affiliations if available), journal name,
volume, issue, page range, publication year, and abstract.
Return ONLY the JSON object with no additional text.`,
      stable_id: uploadedStableId,
      json_schema: METADATA_SCHEMA,
      temperature: 0.1,
      max_retries: 2
    };

    console.log('Calling extraction API...');
    const startTime = Date.now();

    const response = await fetch(`${BASE_URL}/api/plugins/kisski/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId
      },
      body: JSON.stringify(extractRequest)
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Extraction completed in ${elapsed}s`);

    if (response.status !== 200) {
      const errorBody = await response.text();
      console.error('Extraction failed:', errorBody);
    }
    assert.strictEqual(response.status, 200, `Extraction should succeed, got ${response.status}`);

    const result = await response.json();

    // Dump the result for verification
    console.log('\n=== EXTRACTION RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('=========================\n');

    // Basic structure checks
    assert.strictEqual(result.success, true, 'Extraction should succeed');
    assert.ok(result.data, 'Should have extracted data');
    assert.strictEqual(result.model, model, 'Should use requested model');

    // Verify extracted metadata against expected values
    const data = result.data;

    // Title check
    assert.ok(data.title, 'Should have title');
    assert.ok(
      data.title.toLowerCase().includes('citation') ||
      data.title.toLowerCase().includes('humanities'),
      `Title should contain key terms, got: ${data.title}`
    );

    // Authors check
    assert.ok(Array.isArray(data.authors), 'Should have authors array');
    assert.ok(data.authors.length >= 2, 'Should have at least two authors');
    const authorNames = data.authors.map(a => a.name?.toLowerCase() || '').join(' ');
    assert.ok(
      authorNames.includes('colavizza') || authorNames.includes('romanello'),
      `Should include expected authors, got: ${JSON.stringify(data.authors)}`
    );

    // Journal check
    assert.ok(data.journal, 'Should have journal name');
    assert.ok(
      data.journal.toLowerCase().includes('european') ||
      data.journal.toLowerCase().includes('periodical'),
      `Journal should be Journal of European Periodical Studies, got: ${data.journal}`
    );

    // Year check
    assert.ok(data.year, 'Should have publication year');
    assert.ok(
      data.year.includes('2019'),
      `Year should be 2019, got: ${data.year}`
    );

    // Abstract check (if present)
    if (data.abstract) {
      const abstractLower = data.abstract.toLowerCase();
      assert.ok(
        abstractLower.includes('citation') ||
        abstractLower.includes('humanities') ||
        abstractLower.includes('bibliometric'),
        'Abstract should contain relevant terms'
      );
    }

    console.log('All metadata assertions passed!');
  });
});

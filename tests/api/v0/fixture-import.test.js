/**
 * Fixture Import Test
 *
 * Simple test to verify that fixture files are properly imported
 * and accessible via the API. This tests the fixture loading infrastructure.
 *
 * @testCovers tests/lib/fixture-loader.js
 * @testCovers bin/import_files.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';
import { logger } from '../helpers/test-logger.js';

// Get configuration from environment variables
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

describe('Fixture Import Tests', () => {

  test('Should list files from imported fixture', async () => {
    let sessionId = null;

    try {
      // Login as test user
      const { sessionId: sid } = await login('testuser', 'testpass');
      sessionId = sid;

      // List files
      const response = await fetch(`${API_BASE}/files/list`, {
        headers: {
          'Cookie': `sessionId=${sessionId}`
        }
      });

      assert.strictEqual(response.status, 200, 'Files list endpoint should return 200');

      const data = await response.json();
      assert(data.documents, 'Response should have documents array');
      assert(Array.isArray(data.documents), 'Documents should be an array');

      // The standard fixture should have at least one document
      assert(data.documents.length > 0, `Expected at least one document, got ${data.documents.length}`);

      // Check that the example document exists
      const exampleDoc = data.documents.find(doc =>
        doc.doc_id && doc.doc_id.includes('10.5771')
      );

      assert(exampleDoc, 'Should find example document with DOI 10.5771');
      assert(exampleDoc.pdf, 'Document should have a PDF file');
      assert(exampleDoc.pdf.id, 'PDF should have an ID (hash)');

      logger.success(`Found ${data.documents.length} document(s) from fixture`);
      logger.success(`Example document: ${exampleDoc.doc_id}`);
      logger.success(`PDF hash: ${exampleDoc.pdf.id}`);

    } finally {
      // Clean up session
      if (sessionId) {
        await logout(sessionId).catch(() => {}); // Ignore cleanup errors
      }
    }
  });

  test('Should be able to retrieve PDF file content', async () => {
    let sessionId = null;

    try {
      // Login as test user
      const { sessionId: sid } = await login('testuser', 'testpass');
      sessionId = sid;

      // List files to get a file ID
      const listResponse = await fetch(`${API_BASE}/files/list`, {
        headers: {
          'Cookie': `sessionId=${sessionId}`
        }
      });

      const listData = await listResponse.json();
      assert(listData.documents.length > 0, 'Should have at least one document');

      const firstDoc = listData.documents[0];
      assert(firstDoc.pdf, 'First document should have a PDF');
      const pdfId = firstDoc.pdf.id;

      // Download the PDF file
      const fileResponse = await fetch(`${API_BASE}/files/${pdfId}`, {
        headers: {
          'Cookie': `sessionId=${sessionId}`
        }
      });

      assert.strictEqual(fileResponse.status, 200, 'File download should return 200');

      const contentType = fileResponse.headers.get('content-type');
      assert(contentType && contentType.includes('pdf'),
        `Content type should be PDF, got: ${contentType}`);

      const pdfData = await fileResponse.arrayBuffer();
      assert(pdfData.byteLength > 0, 'PDF data should not be empty');

      logger.success(`Successfully downloaded PDF: ${pdfId}`);
      logger.success(`PDF size: ${pdfData.byteLength} bytes`);

    } finally {
      // Clean up session
      if (sessionId) {
        await logout(sessionId).catch(() => {}); // Ignore cleanup errors
      }
    }
  });

  test('Should be able to retrieve TEI file content', async () => {
    let sessionId = null;

    try {
      // Login as test user
      const { sessionId: sid } = await login('testuser', 'testpass');
      sessionId = sid;

      // List files to get a TEI file ID
      const listResponse = await fetch(`${API_BASE}/files/list`, {
        headers: {
          'Cookie': `sessionId=${sessionId}`
        }
      });

      const listData = await listResponse.json();
      assert(listData.documents.length > 0, 'Should have at least one document');

      const firstDoc = listData.documents[0];
      assert(firstDoc.versions && firstDoc.versions.length > 0,
        'First document should have at least one TEI version');

      const teiId = firstDoc.versions[0].id;

      // Download the TEI file
      const fileResponse = await fetch(`${API_BASE}/files/${teiId}`, {
        headers: {
          'Cookie': `sessionId=${sessionId}`
        }
      });

      assert.strictEqual(fileResponse.status, 200, 'File download should return 200');

      const contentType = fileResponse.headers.get('content-type');
      assert(contentType && contentType.includes('xml'),
        `Content type should be XML, got: ${contentType}`);

      const teiData = await fileResponse.text();
      assert(teiData.length > 0, 'TEI data should not be empty');
      assert(teiData.includes('<TEI'), 'TEI data should contain TEI XML tags');

      logger.success(`Successfully downloaded TEI: ${teiId}`);
      logger.success(`TEI size: ${teiData.length} bytes`);

    } finally {
      // Clean up session
      if (sessionId) {
        await logout(sessionId).catch(() => {}); // Ignore cleanup errors
      }
    }
  });
});

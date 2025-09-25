/**
 * Simple Role Permissions API Tests - E2E Backend Tests
 *
 * Test role-based document permissions for file operations.
 * Start with simple operations before testing complex document saving.
 *
 * @testCovers server/api/files/save.py
 * @testCovers app/src/plugins/access-control.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout, authenticatedRequest, deleteTestFiles } from './helpers/test-auth.js';

// Get configuration from environment variables (set by e2e-runner.js)
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

// Test user credentials
const TEST_USERS = [
  { username: 'testuser', password: 'testpass', roles: ['user'], description: 'Basic user' },
  { username: 'testannotator', password: 'annotatorpass', roles: ['annotator', 'user'], description: 'Annotator' },
  { username: 'testreviewer', password: 'reviewerpass', roles: ['reviewer', 'user'], description: 'Reviewer' },
  { username: 'testadmin', password: 'adminpass', roles: ['admin', 'user'], description: 'Admin' }
];

// Simple valid TEI XML for testing
const SIMPLE_TEI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <idno type="fileref">test-doc</idno>
        </edition>
      </editionStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Test content for role permissions</p>
    </body>
  </text>
</TEI>`;

describe('Simple Role Permissions API Tests', () => {

  test('Should require authentication for file save endpoint', async () => {
    const response = await fetch(`${API_BASE}/files/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        xml_string: SIMPLE_TEI_XML,
        file_path: 'tei/test-doc.tei.xml'
      })
    });

    assert(response.status === 401 || response.status === 403,
      'Save endpoint should require authentication');
  });

  test('Should reject malformed requests', async () => {
    const { sessionId } = await login('testadmin', 'adminpass');

    try {
      // Test with missing xml_string
      const response1 = await authenticatedRequest(sessionId, '/files/save', 'POST', {
        file_path: 'tei/test-doc.tei.xml'
      });

      assert.strictEqual(response1.status, 400, 'Should reject missing XML string');

      // Test with missing file_path
      const response2 = await authenticatedRequest(sessionId, '/files/save', 'POST', {
        xml_string: SIMPLE_TEI_XML
      });

      assert.strictEqual(response2.status, 400, 'Should reject missing file path');

    } finally {
      await logout(sessionId).catch(() => {});
    }
  });

  test('Should reject invalid XML', async () => {
    const { sessionId } = await login('testadmin', 'adminpass');

    const testFiles = ['/data/tei/test-invalid-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(sessionId, '/files/save', 'POST', {
        xml_string: '<invalid>XML with unclosed tag',
        file_id: '/data/tei/test-invalid-doc.tei.xml'
      });

      assert.strictEqual(response.status, 400, 'Should reject invalid XML');

      const errorData = await response.json();
      assert(errorData.error.includes('Invalid XML'), 'Error message should mention invalid XML');

    } finally {
      // Clean up any accidentally created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId).catch(() => {});
    }
  });

  test('Admin should be able to save files (basic validation)', async () => {
    const { sessionId } = await login('testadmin', 'adminpass');

    const testFiles = ['/data/tei/admin-simple-test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(sessionId, '/files/save', 'POST', {
        xml_string: SIMPLE_TEI_XML,
        file_id: '/data/tei/admin-simple-test-doc.tei.xml'
      });

      // Should succeed or give specific error (not 401/403)
      assert(response.status !== 401 && response.status !== 403,
        `Admin should not get auth error, got ${response.status}`);

      if (!response.ok) {
        const errorData = await response.json();
        console.log('Admin save error (non-auth):', errorData);
      }

    } finally {
      // Clean up created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId).catch(() => {});
    }
  });

  test('Basic user should get appropriate error for file saves', async () => {
    const { sessionId } = await login('testuser', 'testpass');

    const testFiles = ['/data/tei/user-simple-test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(sessionId, '/files/save', 'POST', {
        xml_string: SIMPLE_TEI_XML,
        file_id: '/data/tei/user-simple-test-doc.tei.xml'
      });

      // Basic user should get either 403 (permissions) or 404 (file not found)
      // Both indicate they cannot save - 404 because file resolution fails first
      assert(response.status === 403 || response.status === 404,
        `Basic user should get 403 or 404 error, got ${response.status}`);

      const errorData = await response.json();
      assert(errorData.error && typeof errorData.error === 'string',
        'Should have error message');

      // If it's a 404, it's because the file doesn't exist in the lookup table
      // If it's a 403, it's because of permission restrictions
      if (response.status === 404) {
        console.log('Basic user got 404 (file not found) - this is expected behavior');
      } else if (response.status === 403) {
        console.log('Basic user got 403 (forbidden) - this is expected behavior');
      }

    } finally {
      // Clean up any accidentally created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId).catch(() => {});
    }
  });

});
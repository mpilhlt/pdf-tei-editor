/**
 * E2E Backend Tests for Role-based Document Permissions API
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

// Test user credentials (passwords: testpass/annotatorpass/reviewerpass/adminpass)
const TEST_USERS = {
  user: { username: 'testuser', password: 'testpass', expectedReadOnly: true },
  annotator: { username: 'testannotator', password: 'annotatorpass', expectedReadOnly: false },
  reviewer: { username: 'testreviewer', password: 'reviewerpass', expectedReadOnly: false },
  admin: { username: 'testadmin', password: 'adminpass', expectedReadOnly: false }
};

// Sample TEI XML content for testing saves
const SAMPLE_TEI_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <p>Test content</p>
    </body>
  </text>
</TEI>`;

describe('Role-based Document Permissions API', () => {

  test('User role: Cannot save version documents (403 expected)', async () => {
    const { sessionId } = await login(TEST_USERS.user.username, TEST_USERS.user.password);

    const testFiles = ['/data/versions/testuser/test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(
        sessionId,
        '/files/save',
        'POST',
        {
          xml_string: SAMPLE_TEI_XML,
          file_id: '/data/versions/testuser/test-doc.tei.xml'
        }
      );

      assert.strictEqual(response.status, 403,
        'User role should be forbidden from saving version documents');

    } finally {
      // Clean up any accidentally created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId);
    }
  });

  test('User role: Cannot save documents (403 expected)', async () => {
    const { sessionId } = await login(TEST_USERS.user.username, TEST_USERS.user.password);

    const testFiles = ['/data/tei/user-test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(
        sessionId,
        '/files/save',
        'POST',
        {
          xml_string: SAMPLE_TEI_XML,
          file_id: '/data/tei/user-test-doc.tei.xml'
        }
      );

      assert.strictEqual(response.status, 403,
        'User role should be forbidden from saving documents');

    } finally {
      // Clean up any accidentally created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId);
    }
  });

  test('Annotator role: Can save documents (200 expected)', async () => {
    const { sessionId } = await login(TEST_USERS.annotator.username, TEST_USERS.annotator.password);

    const testFiles = ['/data/versions/annotator/test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(
        sessionId,
        '/files/save',
        'POST',
        {
          xml_string: SAMPLE_TEI_XML,
          file_id: '/data/versions/annotator/test-doc.tei.xml'
        }
      );

      assert.strictEqual(response.status, 200,
        'Annotator role should be allowed to save documents');

    } finally {
      // Clean up created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId);
    }
  });

  // Note: With the current access control system, annotators can save any documents
  // The distinction between version/gold is handled by the application logic, not the API

  test('Reviewer role: Can save documents (200 expected)', async () => {
    const { sessionId } = await login(TEST_USERS.reviewer.username, TEST_USERS.reviewer.password);

    const testFiles = ['/data/tei/reviewer-test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(
        sessionId,
        '/files/save',
        'POST',
        {
          xml_string: SAMPLE_TEI_XML,
          file_id: '/data/tei/reviewer-test-doc.tei.xml'
        }
      );

      assert.strictEqual(response.status, 200,
        'Reviewer role should be allowed to save documents');

    } finally {
      // Clean up created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId);
    }
  });

  // Note: Reviewer permissions are the same as annotator for document saving

  test('Admin role: Can save documents (200 expected)', async () => {
    const { sessionId } = await login(TEST_USERS.admin.username, TEST_USERS.admin.password);

    const testFiles = ['/data/tei/admin-test-doc.tei.xml'];

    try {
      const response = await authenticatedRequest(
        sessionId,
        '/files/save',
        'POST',
        {
          xml_string: SAMPLE_TEI_XML,
          file_id: '/data/tei/admin-test-doc.tei.xml'
        }
      );

      assert.strictEqual(response.status, 200,
        'Admin role should be allowed to save documents');

    } finally {
      // Clean up created files
      await deleteTestFiles(sessionId, testFiles);
      await logout(sessionId);
    }
  });

});
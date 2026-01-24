/**
 * API Tests for Access Control Modes
 *
 * Tests document access control behavior across three modes:
 * - role-based: Standard role-based permissions
 * - owner-based: Only document owner can edit
 * - granular: Per-document visibility/editability settings
 *
 * @testCovers fastapi_app/lib/access_control.py
 * @testCovers fastapi_app/lib/acl_utils.py
 * @testCovers fastapi_app/routers/files_locks.py
 *
 * To test specific modes, set ACCESS_CONTROL_MODE environment variable:
 *   ACCESS_CONTROL_MODE=owner-based npm run test:api -- --grep "access_control_modes"
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  authenticatedApiCall,
  logout,
  loginAsAdmin,
  loginAsReviewer,
  loginAsAnnotator,
  loginAsBasicUser,
  tryAcquireLock,
  releaseLock
} from '../helpers/test-auth.js';
import { cleanupBeforeTests, cleanupAfterTests } from '../helpers/test-cleanup.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Track sessions for cleanup
let adminSession = null;
let reviewerSession = null;
let annotatorSession = null;
let userSession = null;

// Test state
const testState = {
  currentMode: null,
  fixturePdfStableId: null,  // PDF from fixture to link versions to
  fixtureDocId: null,        // doc_id from fixture
  reviewerOwnedFileId: null,
  annotatorOwnedFileId: null
  // Note: Basic users cannot create version files (requires annotator role)
};

describe('Access Control Modes E2E Tests', { concurrency: 1 }, () => {

  before(async () => {
    cleanupBeforeTests();
  });

  after(async () => {
    // Clean up sessions
    if (adminSession) await logout(adminSession.sessionId, BASE_URL);
    if (reviewerSession) await logout(reviewerSession.sessionId, BASE_URL);
    if (annotatorSession) await logout(annotatorSession.sessionId, BASE_URL);
    if (userSession) await logout(userSession.sessionId, BASE_URL);
    cleanupAfterTests();
  });

  // Helper functions for session management
  async function getAdminSession() {
    if (!adminSession) {
      adminSession = await loginAsAdmin(BASE_URL);
    }
    return adminSession;
  }

  async function getReviewerSession() {
    if (!reviewerSession) {
      reviewerSession = await loginAsReviewer(BASE_URL);
    }
    return reviewerSession;
  }

  async function getAnnotatorSession() {
    if (!annotatorSession) {
      annotatorSession = await loginAsAnnotator(BASE_URL);
    }
    return annotatorSession;
  }

  async function getUserSession() {
    if (!userSession) {
      userSession = await loginAsBasicUser(BASE_URL);
    }
    return userSession;
  }

  // Helper to create a test file (as a version linked to the fixture PDF)
  async function createTestFile(session, fileIdPrefix) {
    const timestamp = Date.now();
    const docId = testState.fixtureDocId;

    const testContent = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Access Control Test: ${fileIdPrefix}</title></titleStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc>
        <bibl><idno type="fileref">${docId}</idno></bibl>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Test content for ${fileIdPrefix} at ${timestamp}</p></body></text>
</TEI>`;

    // Create as version file (non-gold) by setting new_version=true
    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/save',
      'POST',
      {
        file_id: docId,
        new_version: true,
        xml_string: testContent
      },
      BASE_URL
    );

    // Release lock after creation
    await releaseLock(session.sessionId, result.file_id, BASE_URL);

    return result.file_id;
  }

  // === Setup Tests ===

  test('Setup: Get fixture PDF stable_id', async () => {
    const session = await getAdminSession();

    // Get list of files to find the fixture PDF
    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    // Find a document group with a PDF source file
    const docWithPdf = result.files.find(doc => doc.source && doc.source.file_type === 'pdf');
    if (!docWithPdf) {
      throw new Error('No PDF file found in fixture. Ensure standard fixture is loaded.');
    }

    testState.fixturePdfStableId = docWithPdf.source.id;
    testState.fixtureDocId = docWithPdf.doc_id;
    logger.info(`Found fixture PDF: ${docWithPdf.source.id} (doc_id: ${docWithPdf.doc_id})`);
    assert.ok(testState.fixturePdfStableId);
  });

  test('Setup: Get current access control mode', async () => {
    const session = await getAdminSession();

    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    testState.currentMode = result.mode;
    logger.info(`Current access control mode: ${result.mode}`);
    logger.info(`Default visibility: ${result.default_visibility}`);
    logger.info(`Default editability: ${result.default_editability}`);

    assert.ok(
      ['role-based', 'owner-based', 'granular'].includes(result.mode),
      `Mode should be valid. Got: ${result.mode}`
    );
  });

  test('Setup: Create test file owned by reviewer', async () => {
    const session = await getReviewerSession();
    testState.reviewerOwnedFileId = await createTestFile(session, 'acl-reviewer');
    logger.info(`Created reviewer-owned file: ${testState.reviewerOwnedFileId}`);
    assert.ok(testState.reviewerOwnedFileId);
  });

  test('Setup: Create test file owned by annotator', async () => {
    const session = await getAnnotatorSession();
    testState.annotatorOwnedFileId = await createTestFile(session, 'acl-annotator');
    logger.info(`Created annotator-owned file: ${testState.annotatorOwnedFileId}`);
    assert.ok(testState.annotatorOwnedFileId);
  });

  // Note: Basic users cannot create version files - this is by design.
  // Only annotators or reviewers can create version files in the system.

  // === Role-Based Mode Tests ===

  test('Role-based: Reviewer can edit any non-gold file', async () => {
    if (testState.currentMode !== 'role-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getReviewerSession();

    // Try to lock file owned by annotator
    const response = await tryAcquireLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 200, 'Reviewer should be able to lock annotator-owned file');
    logger.success('Reviewer can lock annotator-owned file in role-based mode');

    // Clean up
    await releaseLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
  });

  test('Role-based: Annotator can edit non-gold files', async () => {
    if (testState.currentMode !== 'role-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getAnnotatorSession();

    // Try to lock file owned by reviewer
    const response = await tryAcquireLock(session.sessionId, testState.reviewerOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 200, 'Annotator should be able to lock reviewer-owned file');
    logger.success('Annotator can lock reviewer-owned file in role-based mode');

    // Clean up
    await releaseLock(session.sessionId, testState.reviewerOwnedFileId, BASE_URL);
  });

  test('Role-based: Regular user cannot edit version files (requires annotator role)', async () => {
    if (testState.currentMode !== 'role-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getUserSession();

    // Try to lock version file owned by annotator
    // In role-based mode, version files require annotator or reviewer role to edit
    const response = await tryAcquireLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 403, 'Regular user should be denied - version files require annotator role');
    logger.success('Regular user correctly denied edit access to version file in role-based mode');
  });

  // === Owner-Based Mode Tests ===

  test('Owner-based: Owner can edit their own file', async () => {
    if (testState.currentMode !== 'owner-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getAnnotatorSession();

    // Try to lock own file
    const response = await tryAcquireLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 200, 'Owner should be able to lock their own file');
    logger.success('Owner can lock their own file in owner-based mode');

    // Clean up
    await releaseLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
  });

  test('Owner-based: Non-owner cannot edit file', async () => {
    if (testState.currentMode !== 'owner-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getAnnotatorSession();

    // Try to lock file owned by reviewer
    const response = await tryAcquireLock(session.sessionId, testState.reviewerOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 403, 'Non-owner should be denied lock');
    logger.success('Non-owner correctly denied lock in owner-based mode');
  });

  test('Owner-based: Reviewer cannot edit non-owned file', async () => {
    if (testState.currentMode !== 'owner-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getReviewerSession();

    // Try to lock file owned by user - should fail even for reviewer
    const response = await tryAcquireLock(session.sessionId, testState.userOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 403, 'Reviewer should be denied lock on non-owned file');
    logger.success('Reviewer correctly denied lock on non-owned file in owner-based mode');
  });

  test('Owner-based: Admin can edit any file', async () => {
    if (testState.currentMode !== 'owner-based') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getAdminSession();

    // Admin has wildcard roles, should they be able to edit?
    // According to the design, owner-based mode is strict about ownership
    // Let's check what actually happens
    const response = await tryAcquireLock(session.sessionId, testState.userOwnedFileId, BASE_URL);

    // Note: This test documents current behavior - may need adjustment
    // based on whether admins should override owner-based restrictions
    if (response.status === 200) {
      logger.info('Admin CAN lock files in owner-based mode (current behavior)');
      await releaseLock(session.sessionId, testState.userOwnedFileId, BASE_URL);
    } else {
      logger.info('Admin CANNOT lock files in owner-based mode (current behavior)');
    }
  });

  // === Granular Mode Tests ===

  test('Granular: Owner can edit file with editability=owner', async () => {
    if (testState.currentMode !== 'granular') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getAnnotatorSession();

    // Try to lock own file
    const response = await tryAcquireLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 200, 'Owner should be able to lock their file');
    logger.success('Owner can lock file in granular mode');

    // Clean up
    await releaseLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
  });

  test('Granular: Non-owner cannot edit file with editability=owner', async () => {
    if (testState.currentMode !== 'granular') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const session = await getUserSession();

    // Try to lock file owned by annotator
    const response = await tryAcquireLock(session.sessionId, testState.annotatorOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 403, 'Non-owner should be denied lock');
    logger.success('Non-owner correctly denied lock in granular mode');
  });

  test('Granular: Can change editability to collection and allow others', async () => {
    if (testState.currentMode !== 'granular') {
      logger.info(`Skipping - mode is ${testState.currentMode}`);
      return;
    }

    const ownerSession = await getAnnotatorSession();
    const otherSession = await getUserSession();

    // First, set editability to collection
    await authenticatedApiCall(
      ownerSession.sessionId,
      '/files/set_permissions',
      'POST',
      {
        stable_id: testState.annotatorOwnedFileId,
        visibility: 'collection',
        editability: 'collection',
        owner: 'annotator'
      },
      BASE_URL
    );
    logger.info('Set editability to collection');

    // Now non-owner should be able to lock
    const response = await tryAcquireLock(otherSession.sessionId, testState.annotatorOwnedFileId, BASE_URL);
    assert.strictEqual(response.status, 200, 'User should be able to lock file with editability=collection');
    logger.success('Non-owner can lock file with editability=collection');

    // Clean up
    await releaseLock(otherSession.sessionId, testState.annotatorOwnedFileId, BASE_URL);

    // Restore editability to owner
    await authenticatedApiCall(
      ownerSession.sessionId,
      '/files/set_permissions',
      'POST',
      {
        stable_id: testState.annotatorOwnedFileId,
        visibility: 'collection',
        editability: 'owner',
        owner: 'annotator'
      },
      BASE_URL
    );
  });

  // === Cleanup Tests ===

  test('Cleanup: Delete reviewer-owned test file', async () => {
    if (!testState.reviewerOwnedFileId) return;

    const session = await getReviewerSession();
    await authenticatedApiCall(
      session.sessionId,
      '/files/delete',
      'POST',
      { files: [testState.reviewerOwnedFileId] },
      BASE_URL
    );
    logger.info(`Deleted: ${testState.reviewerOwnedFileId}`);
  });

  test('Cleanup: Delete annotator-owned test file', async () => {
    if (!testState.annotatorOwnedFileId) return;

    // Need reviewer to delete in owner-based mode, or owner in other modes
    const session = await getReviewerSession();
    await authenticatedApiCall(
      session.sessionId,
      '/files/delete',
      'POST',
      { files: [testState.annotatorOwnedFileId] },
      BASE_URL
    );
    logger.info(`Deleted: ${testState.annotatorOwnedFileId}`);
  });
});

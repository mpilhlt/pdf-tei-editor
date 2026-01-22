/**
 * E2E Backend Tests for File Permissions API
 * @testCovers fastapi_app/routers/files_permissions.py
 * @testCovers fastapi_app/lib/access_control.py
 * @testCovers fastapi_app/lib/permissions_db.py
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { authenticatedApiCall, authenticatedRequest, logout, login } from '../helpers/test-auth.js';
import { cleanupBeforeTests, cleanupAfterTests } from '../helpers/test-cleanup.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let reviewerSession = null;
let annotatorSession = null;

describe('File Permissions API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    testFileStableId: null,
    originalMode: null
  };

  // Clean up before all tests
  before(async () => {
    cleanupBeforeTests();
  });

  // Clean up after all tests
  after(async () => {
    // Restore original mode if changed
    if (testState.originalMode && testState.originalMode !== 'granular') {
      // Note: Cannot change mode via API, would need to reset config
      logger.info(`Note: Access control mode was changed to 'granular' for testing`);
    }

    if (reviewerSession) {
      await logout(reviewerSession.sessionId, BASE_URL);
      reviewerSession = null;
    }
    if (annotatorSession) {
      await logout(annotatorSession.sessionId, BASE_URL);
      annotatorSession = null;
    }
    cleanupAfterTests();
  });

  async function getReviewerSession() {
    if (!reviewerSession) {
      reviewerSession = await login('reviewer', 'reviewer', BASE_URL);
      logger.info(`Created reviewer session: ${reviewerSession.sessionId}`);
    }
    return reviewerSession;
  }

  async function getAnnotatorSession() {
    if (!annotatorSession) {
      annotatorSession = await login('annotator', 'annotator', BASE_URL);
      logger.info(`Created annotator session: ${annotatorSession.sessionId}`);
    }
    return annotatorSession;
  }

  test('Get access control mode', async () => {
    const session = await getReviewerSession();

    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    logger.info(`Access control mode: ${JSON.stringify(result)}`);

    // Store original mode
    testState.originalMode = result.mode;

    assert.ok(result.mode, 'Response should have mode');
    assert.ok(['role-based', 'owner-based', 'granular'].includes(result.mode),
      `Mode should be one of: role-based, owner-based, granular. Got: ${result.mode}`);
    assert.ok(result.default_visibility, 'Response should have default_visibility');
    assert.ok(result.default_editability, 'Response should have default_editability');
  });

  test('Setup: Create test file for permission tests', async () => {
    const session = await getReviewerSession();

    const testContent = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Permission Test Document</title></titleStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc>
        <bibl><idno type="fileref">permission-test-${Date.now()}</idno></bibl>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Test content for permissions</p></body></text>
</TEI>`;

    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/save',
      'POST',
      {
        file_id: `permission-test-${Date.now()}`,
        xml_string: testContent
      },
      BASE_URL
    );

    testState.testFileStableId = result.file_id;
    logger.info(`Created test file: ${testState.testFileStableId}`);

    // Release lock
    await authenticatedApiCall(
      session.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: testState.testFileStableId },
      BASE_URL
    );

    assert.ok(testState.testFileStableId, 'Should have created test file');
  });

  test('Permissions API returns 400 in role-based mode', async () => {
    const session = await getReviewerSession();

    // Get current mode
    const modeResult = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    if (modeResult.mode !== 'role-based') {
      logger.info(`Skipping test - mode is ${modeResult.mode}, not role-based`);
      return;
    }

    // Try to get permissions - should fail in role-based mode
    const response = await authenticatedRequest(
      session.sessionId,
      `/files/permissions/${testState.testFileStableId}`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(response.status, 400, `Expected 400 status, got ${response.status}`);
    logger.info('Correctly rejected permissions request in role-based mode');
  });

  // The following tests require granular mode to be enabled
  // They will be skipped if the system is not in granular mode

  test('Get permissions for file (granular mode)', async () => {
    const session = await getReviewerSession();

    // Get current mode
    const modeResult = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    if (modeResult.mode !== 'granular') {
      logger.info(`Skipping test - mode is ${modeResult.mode}, not granular`);
      return;
    }

    const result = await authenticatedApiCall(
      session.sessionId,
      `/files/permissions/${testState.testFileStableId}`,
      'GET',
      null,
      BASE_URL
    );

    logger.info(`File permissions: ${JSON.stringify(result)}`);

    assert.ok(result.stable_id, 'Should have stable_id');
    assert.ok(['collection', 'owner'].includes(result.visibility),
      `Visibility should be collection or owner. Got: ${result.visibility}`);
    assert.ok(['collection', 'owner'].includes(result.editability),
      `Editability should be collection or owner. Got: ${result.editability}`);
    assert.ok(result.owner, 'Should have owner');
  });

  test('Set permissions as owner (granular mode)', async () => {
    const session = await getReviewerSession();

    // Get current mode
    const modeResult = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    if (modeResult.mode !== 'granular') {
      logger.info(`Skipping test - mode is ${modeResult.mode}, not granular`);
      return;
    }

    // Set permissions to owner-only visibility
    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/set_permissions',
      'POST',
      {
        stable_id: testState.testFileStableId,
        visibility: 'owner',
        editability: 'owner',
        owner: 'reviewer'
      },
      BASE_URL
    );

    logger.info(`Updated permissions: ${JSON.stringify(result)}`);

    assert.strictEqual(result.visibility, 'owner', 'Visibility should be owner');
    assert.strictEqual(result.editability, 'owner', 'Editability should be owner');
  });

  test('Non-owner cannot set permissions (granular mode)', async () => {
    const session = await getAnnotatorSession();

    // Get current mode using annotator session
    const modeResult = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    if (modeResult.mode !== 'granular') {
      logger.info(`Skipping test - mode is ${modeResult.mode}, not granular`);
      return;
    }

    // Try to set permissions as non-owner, non-reviewer
    const response = await authenticatedRequest(
      session.sessionId,
      '/files/set_permissions',
      'POST',
      {
        stable_id: testState.testFileStableId,
        visibility: 'collection',
        editability: 'collection',
        owner: 'reviewer'
      },
      BASE_URL
    );

    assert.strictEqual(response.status, 403, `Expected 403 status, got ${response.status}`);
    logger.info('Correctly rejected permission change from non-owner');
  });

  test('Restore permissions to default (granular mode)', async () => {
    const session = await getReviewerSession();

    // Get current mode
    const modeResult = await authenticatedApiCall(
      session.sessionId,
      '/files/access_control_mode',
      'GET',
      null,
      BASE_URL
    );

    if (modeResult.mode !== 'granular') {
      logger.info(`Skipping test - mode is ${modeResult.mode}, not granular`);
      return;
    }

    // Restore to default permissions
    const result = await authenticatedApiCall(
      session.sessionId,
      '/files/set_permissions',
      'POST',
      {
        stable_id: testState.testFileStableId,
        visibility: modeResult.default_visibility,
        editability: modeResult.default_editability,
        owner: 'reviewer'
      },
      BASE_URL
    );

    logger.info(`Restored permissions: ${JSON.stringify(result)}`);

    assert.strictEqual(result.visibility, modeResult.default_visibility);
    assert.strictEqual(result.editability, modeResult.default_editability);
  });

  test('Cleanup: Delete test file', async () => {
    if (!testState.testFileStableId) {
      logger.info('No test file to clean up');
      return;
    }

    const session = await getReviewerSession();

    await authenticatedApiCall(
      session.sessionId,
      '/files/delete',
      'POST',
      { files: [testState.testFileStableId] },
      BASE_URL
    );

    logger.info(`Deleted test file: ${testState.testFileStableId}`);
  });
});

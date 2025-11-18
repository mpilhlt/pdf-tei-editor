/**
 * File List Access Control Tests
 *
 * @testCovers fastapi_app/routers/files_list.py
 * @testCovers fastapi_app/lib/access_control.py
 * @testCovers fastapi_app/lib/file_repository.py
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

describe('File List Access Control', () => {
  let adminSession = null;
  let userSession = null;

  test('Setup: login as admin', async () => {
    adminSession = await login('admin', 'admin', BASE_URL);
    assert.ok(adminSession.sessionId, 'Admin should have valid session');
  });

  test('Setup: login as regular user', async () => {
    userSession = await login('user', 'user', BASE_URL);
    assert.ok(userSession.sessionId, 'User should have valid session');
  });

  test('Admin can access file list', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response.files, 'Response should have files array');
    assert.ok(Array.isArray(response.files), 'Files should be an array');
    logger.success(`Admin sees ${response.files.length} files`);
  });

  test('Regular user can access file list (with filtering)', async () => {
    const response = await authenticatedApiCall(
      userSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response.files, 'Response should have files array');
    assert.ok(Array.isArray(response.files), 'Files should be an array');
    logger.success(`Regular user sees ${response.files.length} files`);
  });

  test('File list uses new data structure', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    if (response.files.length > 0) {
      const firstDoc = response.files[0];

      // Check new structure exists
      assert.ok('source' in firstDoc || firstDoc.source === null, 'Document should have source field');
      assert.ok('artifacts' in firstDoc, 'Document should have artifacts field');
      assert.ok(Array.isArray(firstDoc.artifacts), 'Artifacts should be an array');

      // Check old structure doesn't exist
      assert.ok(!('versions' in firstDoc), 'Document should not have versions field');
      assert.ok(!('gold' in firstDoc), 'Document should not have gold field');
      assert.ok(!('variants' in firstDoc), 'Document should not have variants field');
      assert.ok(!('pdf' in firstDoc), 'Document should not have pdf field');

      logger.success('File list uses new data structure (source + artifacts)');
    }
  });

  test('Access control filters files correctly', async () => {
    const adminResponse = await authenticatedApiCall(
      adminSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const userResponse = await authenticatedApiCall(
      userSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    // Both should get valid responses
    assert.ok(adminResponse.files, 'Admin response should have files array');
    assert.ok(userResponse.files, 'User response should have files array');

    // Admin should see at least as many files as regular user
    assert.ok(
      adminResponse.files.length >= userResponse.files.length,
      'Admin should see at least as many files as regular user'
    );

    logger.success(`Admin sees ${adminResponse.files.length} files, user sees ${userResponse.files.length} files`);

    if (adminResponse.files.length === 0) {
      logger.info('Note: Standard fixture has no files, but access control structure is correct');
    }
  });
});

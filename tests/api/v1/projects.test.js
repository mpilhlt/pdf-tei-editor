/**
 * Projects API integration tests.
 *
 * @testCovers fastapi_app/routers/projects.py
 * @testCovers fastapi_app/lib/utils/project_utils.py
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

describe('Projects API', () => {
  let adminSessionId = null;
  let userSessionId = null;
  const testProjectId = 'test-project-api-' + Date.now();

  test('Setup: login as admin', async () => {
    const session = await login('admin', 'admin', BASE_URL);
    adminSessionId = session.sessionId;
    assert.ok(adminSessionId);
  });

  test('Setup: login as regular user', async () => {
    const session = await login('reviewer', 'reviewer', BASE_URL);
    userSessionId = session.sessionId;
    assert.ok(userSessionId);
  });

  test('Admin can list all projects', async () => {
    const projects = await authenticatedApiCall(adminSessionId, '/projects', 'GET', null, BASE_URL);
    assert.ok(Array.isArray(projects));
    logger.success(`Admin sees ${projects.length} projects`);
  });

  test('Admin can create a project', async () => {
    const body = {
      id: testProjectId,
      name: 'Test Project API',
      description: 'Created by test',
      members: [],
      collections: []
    };
    const project = await authenticatedApiCall(adminSessionId, '/projects', 'POST', body, BASE_URL);
    assert.equal(project.id, testProjectId);
    assert.equal(project.name, 'Test Project API');
    logger.success(`Created project: ${project.id}`);
  });

  test('Admin can get a project by ID', async () => {
    const project = await authenticatedApiCall(adminSessionId, `/projects/${testProjectId}`, 'GET', null, BASE_URL);
    assert.equal(project.id, testProjectId);
    assert.equal(project.name, 'Test Project API');
  });

  test('Admin can update a project', async () => {
    const updated = await authenticatedApiCall(
      adminSessionId, `/projects/${testProjectId}`, 'PUT',
      { name: 'Updated Project Name' }, BASE_URL
    );
    assert.equal(updated.name, 'Updated Project Name');
  });

  test('Regular user does not see project they are not a member of (404)', async () => {
    let threw = false;
    try {
      await authenticatedApiCall(userSessionId, `/projects/${testProjectId}`, 'GET', null, BASE_URL);
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('404'), `Expected 404 but got: ${e.message}`);
    }
    assert.ok(threw, 'Should throw 404 for non-member user');
  });

  test('Regular user sees only their own projects in list', async () => {
    const projects = await authenticatedApiCall(userSessionId, '/projects', 'GET', null, BASE_URL);
    assert.ok(Array.isArray(projects));
    const found = projects.find(p => p.id === testProjectId);
    assert.ok(!found, 'Non-member user should not see the test project in list');
  });

  test('Admin can set project config', async () => {
    const result = await authenticatedApiCall(
      adminSessionId, `/projects/${testProjectId}/config`, 'POST',
      { key: 'test.key', value: 'test-value' }, BASE_URL
    );
    assert.equal(result.key, 'test.key');
    assert.equal(result.value, 'test-value');
  });

  test('Admin can get project config', async () => {
    const result = await authenticatedApiCall(
      adminSessionId, `/projects/${testProjectId}/config`, 'GET', null, BASE_URL
    );
    assert.ok(result.config);
    assert.equal(result.config['test.key'], 'test-value');
  });

  test('Admin can delete project config key', async () => {
    await authenticatedApiCall(
      adminSessionId, `/projects/${testProjectId}/config/test.key`, 'DELETE', null, BASE_URL
    );
    const result = await authenticatedApiCall(
      adminSessionId, `/projects/${testProjectId}/config`, 'GET', null, BASE_URL
    );
    assert.ok(!('test.key' in result.config));
  });

  test('Admin can delete the project', async () => {
    const result = await authenticatedApiCall(
      adminSessionId, `/projects/${testProjectId}`, 'DELETE', null, BASE_URL
    );
    assert.ok(result.success);
  });

  test('Deleted project returns 404', async () => {
    let threw = false;
    try {
      await authenticatedApiCall(adminSessionId, `/projects/${testProjectId}`, 'GET', null, BASE_URL);
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('404'), `Expected 404 but got: ${e.message}`);
    }
    assert.ok(threw, 'Deleted project should return 404');
  });
});

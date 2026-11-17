/**
 * API tests for renaming the ids of users, projects and collections.
 *
 * @testCovers fastapi_app/routers/users.py
 * @testCovers fastapi_app/routers/projects.py
 * @testCovers fastapi_app/routers/collections.py
 * @testCovers fastapi_app/lib/utils/rename_utils.py
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

/**
 * Asserts that an API call fails with the given HTTP status.
 * @param {Promise<any>} call
 * @param {number} status
 */
async function assertFails(call, status) {
  await assert.rejects(call, (/** @type {Error} */ e) => e.message.includes(` ${status} `));
}

describe('Rename API', () => {
  const suffix = Date.now();
  const userId = `rename-user-${suffix}`;
  const newUserId = `renamed-user-${suffix}`;
  const projectId = `rename-project-${suffix}`;
  const newProjectId = `renamed-project-${suffix}`;
  const collectionId = `rename-col-${suffix}`;
  const newCollectionId = `renamed-col-${suffix}`;
  /** @type {string} */
  let adminSession;
  /** @type {string} */
  let userSession;

  test('Setup: create user, collection and project', async () => {
    adminSession = (await login('admin', 'admin', BASE_URL)).sessionId;
    await authenticatedApiCall(adminSession, '/users', 'POST', { username: userId, password: 'secret', roles: ['user'] }, BASE_URL);
    await authenticatedApiCall(adminSession, '/collections', 'POST', { id: collectionId, name: 'Rename test' }, BASE_URL);
    await authenticatedApiCall(adminSession, '/projects', 'POST', {
      id: projectId, name: 'Rename test', members: [userId], collections: [collectionId]
    }, BASE_URL);
    userSession = (await login(userId, 'secret', BASE_URL)).sessionId;
  });

  test('Non-admins cannot rename', async () => {
    await assertFails(authenticatedApiCall(userSession, `/users/${userId}/rename`, 'POST', { new_id: newUserId }, BASE_URL), 403);
    await assertFails(authenticatedApiCall(userSession, `/collections/${collectionId}/rename`, 'POST', { new_id: newCollectionId }, BASE_URL), 403);
  });

  test('Invalid, taken and unknown ids are refused', async () => {
    await assertFails(authenticatedApiCall(adminSession, `/users/${userId}/rename`, 'POST', { new_id: 'has space' }, BASE_URL), 400);
    await assertFails(authenticatedApiCall(adminSession, `/users/${userId}/rename`, 'POST', { new_id: 'admin' }, BASE_URL), 409);
    await assertFails(authenticatedApiCall(adminSession, `/projects/no-such-project-${suffix}/rename`, 'POST', { new_id: 'x' }, BASE_URL), 404);
  });

  test('Renaming a user keeps the session and updates project membership', async () => {
    const result = await authenticatedApiCall(adminSession, `/users/${userId}/rename`, 'POST', { new_id: newUserId }, BASE_URL);
    assert.equal(result.new_id, newUserId);
    assert.equal(result.changes.sessions, 1);

    const status = await authenticatedApiCall(userSession, '/auth/status', 'GET', null, BASE_URL);
    assert.equal(status.username, newUserId);

    const project = await authenticatedApiCall(adminSession, `/projects/${projectId}`, 'GET', null, BASE_URL);
    assert.deepEqual(project.members, [newUserId]);
  });

  test('Renaming a collection updates projects and keeps access', async () => {
    const result = await authenticatedApiCall(adminSession, `/collections/${collectionId}/rename`, 'POST', { new_id: newCollectionId }, BASE_URL);
    assert.equal(result.changes.projects, 1);

    const project = await authenticatedApiCall(adminSession, `/projects/${projectId}`, 'GET', null, BASE_URL);
    assert.deepEqual(project.collections, [newCollectionId]);

    const collections = await authenticatedApiCall(userSession, '/collections', 'GET', null, BASE_URL);
    assert.ok(collections.some((/** @type {{id: string}} */ c) => c.id === newCollectionId));
  });

  test('Renaming a project keeps members and collections', async () => {
    await authenticatedApiCall(adminSession, `/projects/${projectId}/rename`, 'POST', { new_id: newProjectId }, BASE_URL);
    const project = await authenticatedApiCall(adminSession, `/projects/${newProjectId}`, 'GET', null, BASE_URL);
    assert.deepEqual(project.members, [newUserId]);
    assert.deepEqual(project.collections, [newCollectionId]);
    await assertFails(authenticatedApiCall(adminSession, `/projects/${projectId}`, 'GET', null, BASE_URL), 404);
  });

  test('Cleanup', async () => {
    await authenticatedApiCall(adminSession, `/projects/${newProjectId}`, 'DELETE', null, BASE_URL);
    await authenticatedApiCall(adminSession, `/collections/${newCollectionId}`, 'DELETE', null, BASE_URL);
    await authenticatedApiCall(adminSession, `/users/${newUserId}`, 'DELETE', null, BASE_URL);
  });
});

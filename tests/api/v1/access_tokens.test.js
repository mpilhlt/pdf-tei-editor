/**
 * Personal access tokens API tests
 *
 * @testCovers fastapi_app/routers/access_tokens.py
 * @testCovers fastapi_app/api/auth.py
 * @testCovers fastapi_app/lib/core/access_tokens.py
 * @testCovers fastapi_app/lib/permissions/access_token_permissions.py
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  logout,
  authenticatedApiCall,
  authenticatedRequest,
  createTestUser,
  deleteTestUser,
  loginAsUser,
  createAdminSession,
  API_BASE
} from '../helpers/test-auth.js';

const REVIEWER = { username: 'tokens-test-reviewer', password: 'reviewerpass' };
const ANNOTATOR = { username: 'tokens-test-annotator', password: 'annotatorpass' };

/**
 * Exchange a token for a session
 * @param {string} token
 * @returns {Promise<Response>}
 */
async function tokenLogin(token) {
  return fetch(`${API_BASE}/auth/token-login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
}

describe('Access tokens API', () => {
  /** @type {string} */
  let reviewer;
  /** @type {string} */
  let annotator;
  /** @type {string} */
  let admin;
  let annotatorDeleted = false;

  before(async () => {
    await createTestUser(REVIEWER.username, REVIEWER.password, ['user', 'annotator', 'reviewer']);
    await createTestUser(ANNOTATOR.username, ANNOTATOR.password, ['user', 'annotator']);
    reviewer = await loginAsUser(REVIEWER.username, REVIEWER.password);
    annotator = await loginAsUser(ANNOTATOR.username, ANNOTATOR.password);
    admin = (await createAdminSession()).sessionId;
  });

  after(async () => {
    for (const sessionId of [reviewer, admin]) {
      if (sessionId) await logout(sessionId);
    }
    await deleteTestUser(REVIEWER.username);
    if (!annotatorDeleted) await deleteTestUser(ANNOTATOR.username);
  });

  test('should reject listing tokens without authentication', async () => {
    const response = await fetch(`${API_BASE}/auth/tokens`);
    assert.strictEqual(response.status, 401);
  });

  test('annotators cannot create tokens', async () => {
    const response = await authenticatedRequest(annotator, '/auth/tokens', 'POST', { label: 'nope' });
    assert.strictEqual(response.status, 403);
  });

  test('reviewer cannot create a token for an admin', async () => {
    const response = await authenticatedRequest(reviewer, '/auth/tokens', 'POST', { label: 'nope', username: 'admin' });
    assert.strictEqual(response.status, 403);
    const eligible = await authenticatedApiCall(reviewer, '/auth/tokens/eligible-users');
    const names = eligible.map((/** @type {{username: string}} */ u) => u.username);
    assert.ok(names.includes(REVIEWER.username));
    assert.ok(names.includes(ANNOTATOR.username));
    assert.ok(!names.includes('admin'));
  });

  test('token login returns a working session that ends when the token is revoked', async () => {
    const { token, info } = await authenticatedApiCall(reviewer, '/auth/tokens', 'POST', { label: 'api test', expires_in_days: 7 });
    assert.match(token, /^pte_[a-z2-7]{8}_/);
    assert.strictEqual(info.username, REVIEWER.username);

    const listed = await authenticatedApiCall(reviewer, '/auth/tokens');
    assert.ok(listed.some((/** @type {{token_id: string}} */ t) => t.token_id === info.token_id));
    assert.ok(listed.every((/** @type {object} */ t) => !('token' in t)), 'The token itself must never be listed');

    const response = await tokenLogin(token);
    assert.strictEqual(response.status, 200);
    const { sessionId, username } = await response.json();
    assert.strictEqual(username, REVIEWER.username);
    const status = await authenticatedApiCall(sessionId, '/auth/status');
    assert.strictEqual(status.username, REVIEWER.username);
    await authenticatedApiCall(sessionId, '/files/locks');

    const revoked = await authenticatedApiCall(reviewer, `/auth/tokens/${info.token_id}`, 'DELETE');
    assert.deepStrictEqual(revoked, { revoked: true });
    const afterRevoke = await authenticatedRequest(sessionId, '/auth/status');
    assert.strictEqual(afterRevoke.status, 401, 'The session of a revoked token must end');
    assert.strictEqual((await tokenLogin(token)).status, 401);
  });

  test('token login rejects unknown tokens', async () => {
    const response = await tokenLogin('pte_aaaaaaaa_not-a-secret');
    assert.strictEqual(response.status, 401);
  });

  test('reviewer token for an annotator is visible to the annotator and revoked when the user is deleted', async () => {
    const { token, info } = await authenticatedApiCall(reviewer, '/auth/tokens', 'POST', { label: 'for annotator', username: ANNOTATOR.username });
    assert.strictEqual(info.created_by, REVIEWER.username);
    const own = await authenticatedApiCall(annotator, '/auth/tokens');
    assert.deepStrictEqual(own.map((/** @type {{token_id: string}} */ t) => t.token_id), [info.token_id]);
    const all = await authenticatedApiCall(admin, '/auth/tokens');
    assert.ok(all.some((/** @type {{token_id: string}} */ t) => t.token_id === info.token_id));

    const response = await tokenLogin(token);
    assert.strictEqual(response.status, 200);
    const { sessionId } = await response.json();

    await deleteTestUser(ANNOTATOR.username);
    annotatorDeleted = true;
    assert.strictEqual((await tokenLogin(token)).status, 401);
    assert.strictEqual((await authenticatedRequest(sessionId, '/auth/status')).status, 401);
    const remaining = await authenticatedApiCall(reviewer, '/auth/tokens');
    assert.ok(!remaining.some((/** @type {{token_id: string}} */ t) => t.token_id === info.token_id));
  });
});

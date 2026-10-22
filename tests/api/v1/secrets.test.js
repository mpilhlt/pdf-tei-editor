/**
 * User secrets (API keys) API tests
 *
 * Uses the secret service `test-secret-service` registered by the test plugin
 * (tests/fixtures/plugins/test_plugin/).
 *
 * @testCovers fastapi_app/routers/secrets.py
 * @testCovers fastapi_app/lib/secrets/store.py
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
  API_BASE
} from '../helpers/test-auth.js';

const SERVICE = 'test-secret-service';
const ALICE = { username: 'secrets-test-alice', password: 'alicepass' };
const BOB = { username: 'secrets-test-bob', password: 'bobpass' };

/**
 * Whether the user of the session has a key for the test service
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function hasKey(sessionId) {
  const services = await authenticatedApiCall(sessionId, '/secrets', 'GET');
  const service = services.find((/** @type {{id: string}} */ s) => s.id === SERVICE);
  assert.ok(service, `${SERVICE} should be registered by the test plugin`);
  return service.is_set;
}

describe('User secrets API', () => {
  /** @type {string} */
  let alice;
  /** @type {string} */
  let bob;

  before(async () => {
    await createTestUser(ALICE.username, ALICE.password, ['user']);
    await createTestUser(BOB.username, BOB.password, ['user']);
    alice = await loginAsUser(ALICE.username, ALICE.password);
    bob = await loginAsUser(BOB.username, BOB.password);
  });

  after(async () => {
    for (const sessionId of [alice, bob]) {
      if (sessionId) await authenticatedRequest(sessionId, '/secrets', 'DELETE');
      if (sessionId) await logout(sessionId);
    }
    await deleteTestUser(ALICE.username);
    await deleteTestUser(BOB.username);
  });

  test('should reject removing all keys without authentication', async () => {
    const response = await fetch(`${API_BASE}/secrets`, { method: 'DELETE' });
    assert.strictEqual(response.status, 401);
  });

  test('should remove all keys of the user only', async () => {
    await authenticatedApiCall(alice, `/secrets/${SERVICE}`, 'PUT', { value: 'alice-key' });
    await authenticatedApiCall(bob, `/secrets/${SERVICE}`, 'PUT', { value: 'bob-key' });
    assert.strictEqual(await hasKey(alice), true);
    assert.strictEqual(await hasKey(bob), true);

    const result = await authenticatedApiCall(alice, '/secrets', 'DELETE');
    assert.deepStrictEqual(result, { removed: 1 });
    assert.strictEqual(await hasKey(alice), false);
    assert.strictEqual(await hasKey(bob), true, "Other users' keys must not be removed");

    assert.deepStrictEqual(await authenticatedApiCall(alice, '/secrets', 'DELETE'), { removed: 0 });
  });
});

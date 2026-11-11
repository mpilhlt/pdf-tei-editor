/**
 * API Integration Tests for plugin page launch tokens
 *
 * POST /api/v1/plugins/launch-token creates a single-use token. Opening a plugin
 * route with ?launch=<token> sets the plugin session cookie and redirects to the
 * URL without the token; the cookie then authenticates the plugin routes.
 *
 * @testCovers fastapi_app/lib/plugins/plugin_window_auth.py
 * @testCovers fastapi_app/routers/plugins.py
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { loginAsAdmin } from '../helpers/test-auth.js';

const API_BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';
const WHOAMI = '/api/plugins/test-plugin/whoami';

/**
 * Create a launch token for a session
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
async function createLaunchToken(sessionId) {
  const response = await fetch(`${API_BASE}/api/v1/plugins/launch-token`, {
    method: 'POST',
    headers: { 'X-Session-ID': sessionId }
  });
  assert.strictEqual(response.status, 200);
  const { token, expires_in } = await response.json();
  assert.ok(token);
  assert.ok(expires_in > 0);
  return token;
}

/**
 * Extract the "name=value" part of the plugin session cookie from a response
 * @param {Response} response
 * @returns {string}
 */
function pluginCookie(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  const match = setCookie.match(/pte_plugin_session=[^;]+/);
  assert.ok(match, `Expected the plugin session cookie, got: ${setCookie}`);
  return match[0];
}

test('POST /api/v1/plugins/launch-token requires a session', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/launch-token`, { method: 'POST' });
  assert.strictEqual(response.status, 401);
});

test('launch token is exchanged for a cookie that authenticates plugin routes', async () => {
  const { sessionId } = await loginAsAdmin();
  const token = await createLaunchToken(sessionId);

  const exchange = await fetch(`${API_BASE}${WHOAMI}?x=1&launch=${token}`, { redirect: 'manual' });
  assert.strictEqual(exchange.status, 303);
  assert.strictEqual(exchange.headers.get('location'), `${WHOAMI}?x=1`);
  const setCookie = exchange.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/api\/plugins\//);
  assert.ok(!setCookie.includes(token), 'The cookie must not contain the launch token');

  const cookie = pluginCookie(exchange);
  const page = await fetch(`${API_BASE}${WHOAMI}?x=1`, { headers: { Cookie: cookie } });
  assert.strictEqual(page.status, 200);
  assert.deepStrictEqual(await page.json(), { username: 'admin' });

  // Without the cookie, the route is not authenticated
  const anonymous = await fetch(`${API_BASE}${WHOAMI}`);
  assert.strictEqual(anonymous.status, 401);
});

test('launch token can only be used once', async () => {
  const { sessionId } = await loginAsAdmin();
  const token = await createLaunchToken(sessionId);

  const first = await fetch(`${API_BASE}${WHOAMI}?launch=${token}`, { redirect: 'manual' });
  assert.strictEqual(first.status, 303);
  const second = await fetch(`${API_BASE}${WHOAMI}?launch=${token}`, { redirect: 'manual' });
  assert.strictEqual(second.status, 401);
  assert.strictEqual(second.headers.get('set-cookie'), null);
});

test('cookie-authenticated POST from another origin is rejected', async () => {
  const { sessionId } = await loginAsAdmin();
  const token = await createLaunchToken(sessionId);
  const exchange = await fetch(`${API_BASE}${WHOAMI}?launch=${token}`, { redirect: 'manual' });
  const cookie = pluginCookie(exchange);

  const crossOrigin = await fetch(`${API_BASE}${WHOAMI}`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example' }
  });
  assert.strictEqual(crossOrigin.status, 403);

  const sameOrigin = await fetch(`${API_BASE}${WHOAMI}`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: new URL(API_BASE).origin }
  });
  assert.strictEqual(sameOrigin.status, 200);
});

test('logout clears the cookie and ends its session', async () => {
  const { sessionId } = await loginAsAdmin();
  const token = await createLaunchToken(sessionId);
  const exchange = await fetch(`${API_BASE}${WHOAMI}?launch=${token}`, { redirect: 'manual' });
  const cookie = pluginCookie(exchange);

  const response = await fetch(`${API_BASE}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { 'X-Session-ID': sessionId }
  });
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('set-cookie') || '', /pte_plugin_session=""?;.*Path=\/api\/plugins\//);

  const page = await fetch(`${API_BASE}${WHOAMI}`, { headers: { Cookie: cookie } });
  assert.strictEqual(page.status, 401);
});

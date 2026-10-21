/**
 * Edit History Plugin E2E Tests
 *
 * @testCovers fastapi_app/plugins/edit_history/routes.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { performLogin } from './helpers/login-helper.js';

test.describe('Edit History Plugin', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await performLogin(page);
  });

  test('dashboard routes answer for the logged-in user', async ({ page }) => {
    const sessionId = await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().sessionId);
    const headers = { 'X-Session-ID': sessionId };
    for (const path of [
      '/api/plugins/edit-history/recent',
      '/api/plugins/edit-history/all'
    ]) {
      const response = await page.request.get(path, { headers });
      expect(response.status(), path).toBe(200);
    }
  });
});

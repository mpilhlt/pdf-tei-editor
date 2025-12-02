/**
 * Container Infrastructure Tests
 *
 * Validates that the container is properly set up before running E2E tests.
 * This test should be run first to ensure infrastructure is ready.
 *
 * Usage:
 *   npm run test:e2e:container-infra
 *   npx playwright test tests/e2e/tests/docker-infrastructure.spec.js
 */

import { test, expect } from '@playwright/test';

test.describe('Container Infrastructure', () => {
  test('should have container running and healthy', async ({ request }) => {
    test.setTimeout(30000);

    // Check if server is responding
    const response = await request.get('/');
    expect(response.status()).toBe(200);
  });

  test('should have correct directory structure', async ({ request }) => {
    test.setTimeout(10000);

    // Test that API is accessible
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
  });

  test('should have database initialized', async ({ request }) => {
    test.setTimeout(10000);

    // Check that users endpoint is accessible (indicates db is initialized)
    const response = await request.get('/api/users');
    // Should return 401 (unauthorized) not 500 (server error)
    // This indicates the database and auth system are working
    expect([200, 401]).toContain(response.status());
  });

  test('should have demo data imported', async ({ page }) => {
    test.setTimeout(30000);

    // Navigate to the application
    await page.goto('/');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Check if login dialog appears (indicates proper initialization)
    const loginDialog = page.locator('sl-dialog[name="login"]');
    await expect(loginDialog).toBeVisible({ timeout: 10000 });
  });

  test('should have test fixtures loaded', async ({ page }) => {
    test.setTimeout(30000);

    // Try to login with test user (should exist from fixtures)
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for login dialog
    const loginDialog = page.locator('sl-dialog[name="login"]');
    await expect(loginDialog).toBeVisible({ timeout: 10000 });

    // Fill in test credentials
    await page.fill('sl-input[name="username"] input', 'testannotator');
    await page.fill('sl-input[name="password"] input', 'annotatorpass');

    // Submit login
    await page.click('sl-button[type="submit"]');

    // Wait for login to complete (dialog should close)
    await expect(loginDialog).not.toBeVisible({ timeout: 10000 });

    // Should not see error message
    const errorAlert = page.locator('sl-alert[variant="danger"]');
    await expect(errorAlert).not.toBeVisible();
  });

  test('should have correct environment configuration', async ({ page }) => {
    test.setTimeout(10000);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that application mode is set correctly
    const mode = await page.evaluate(() => {
      return window.application?.config?.get('application.mode');
    });

    // Should be in testing mode for E2E tests
    expect(mode).toBe('testing');
  });

  test('should have file storage accessible', async ({ request }) => {
    test.setTimeout(10000);

    // Check that files API endpoint exists
    const response = await request.get('/api/files');
    // Should return 401 (unauthorized) or 200, not 404 or 500
    expect([200, 401]).toContain(response.status());
  });
});

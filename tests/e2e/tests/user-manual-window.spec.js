/**
 * User manual window and search end-to-end tests
 *
 * Searches the manual in the drawer (search button in the header, Ctrl+K), opens a result, opens the section in the
 * standalone manual window, and uses the window without a login: deep link to a heading, search, navigation with
 * the browser history and a page that does not exist.
 *
 * @testCovers app/src/plugins/info.js
 * @testCovers app/src/templates/info-drawer.html
 * @testCovers app/src/manual.js
 * @testCovers app/web/manual.html
 * @testCovers app/web/bootstrap.js
 * @testCovers app/src/modules/manual-viewer.js
 * @testCovers app/src/modules/manual-search.js
 * @testCovers app/src/modules/manual-search-box.js
 * @testCovers fastapi_app/main.py
 * @testCovers fastapi_app/routers/manual.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*404'
];

test.describe('User manual window and search', () => {

  test('search in the drawer and open the section in the manual window', async ({ page, context }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await page.evaluate(() => /** @type {any} */ (window).appInfo.open('user-manual/review-workflow.md'));
      const drawer = page.locator('sl-drawer[name="infoDrawer"]');
      await expect(drawer).toHaveAttribute('open', '');
      await expect(drawer.locator('#overview')).toBeAttached();

      // the search button replaces the title with the search field
      const input = drawer.locator('sl-input[name="searchInput"]');
      await expect(input).toBeHidden();
      await drawer.locator('sl-icon-button[data-name="searchBtn"]').click();
      await expect(input).toBeVisible();
      await expect(drawer.locator('[name="titleText"]')).toBeHidden();

      // results are grouped by page and the best section is preselected
      await input.locator('input').fill('disputed units');
      const results = drawer.locator('[name="searchResults"]');
      await expect(results.locator('.manual-search-page').first()).toContainText('Review Workflow');
      await expect(results.locator('.manual-search-section.selected')).toContainText('Disputed units');

      // Enter opens the section, highlights the words and closes the search
      await page.keyboard.press('Enter');
      await expect(input).toBeHidden();
      await expect(drawer.locator('#disputed-units mark.manual-search-mark').first()).toBeAttached();

      // Ctrl+K opens the search again, Esc closes it without closing the drawer
      await page.keyboard.press('Control+k');
      await expect(input).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(input).toBeHidden();
      await expect(drawer).toHaveAttribute('open', '');

      // "Open in new window" opens the manual window at the section shown
      await expect.poll(() => page.evaluate(() => {
        const drawer = /** @type {any} */ (window).ui.infoDrawer;
        const body = drawer.shadowRoot.querySelector('[part="body"]');
        const heading = drawer.content.querySelector('#disputed-units');
        return Math.abs(heading.getBoundingClientRect().top - body.getBoundingClientRect().top);
      })).toBeLessThan(40);
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        drawer.locator('sl-icon-button[data-name="openWindowBtn"]').click()
      ]);
      await popup.waitForLoadState();
      expect(popup.url()).toMatch(/\/manual\/user-manual\/review-workflow(\?dev)?#disputed-units$/);
      await expect(popup.locator('[data-name="content"] #disputed-units')).toBeVisible();
      await popup.close();

      // headings copy the window URL
      await page.evaluate(() => {
        /** @type {any} */ (window).copiedText = null;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (/** @type {string} */ text) => { /** @type {any} */ (window).copiedText = text; } }
        });
      });
      const heading = drawer.locator('#disputed-units');
      await heading.hover();
      await heading.locator('sl-icon-button.heading-link').click();
      const copied = await page.evaluate(() => /** @type {any} */ (window).copiedText);
      expect(copied).toBe(new URL('/manual/user-manual/review-workflow#disputed-units', page.url()).toString());

      await drawer.locator('sl-button[name="closeBtn"]').click();
    } finally {
      stopErrorMonitoring();
      await performLogout(page);
    }
  });

  test('the manual window works without login, with deep links, search and history', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // a deep link shows the section
      await page.goto('/manual/user-manual/access-tokens#using-a-token');
      const content = page.locator('[data-name="content"]');
      await expect(content.locator('#using-a-token')).toBeInViewport();
      await expect(page).toHaveTitle(/Personal Access Tokens/);
      await expect(page.locator('[data-name="toc"] a', { hasText: 'Using a token' })).toBeVisible();

      // links to ".md" files get the clean URL
      await page.goto('/manual/user-manual/bookmarks.md');
      await expect(content.locator('h1')).toContainText('Bookmarks');
      expect(new URL(page.url()).pathname).toBe('/manual/user-manual/bookmarks');

      // search finds body text and opens the section under its URL
      const input = page.locator('sl-input[data-name="searchInput"]');
      await page.keyboard.press('/');
      await expect(input).toBeFocused();
      await input.locator('input').fill('personal access token');
      const results = page.locator('[data-name="searchResults"]');
      await expect(results.locator('.manual-search-page').first()).toContainText('Personal Access Tokens');
      await results.locator('.manual-search-page').first().click();
      await expect(content.locator('h1')).toContainText('Personal Access Tokens');
      expect(new URL(page.url()).pathname).toBe('/manual/user-manual/access-tokens');

      // the browser history goes back to the previous page
      await page.goBack();
      await expect(content.locator('h1')).toContainText('Bookmarks');

      // links between pages stay in the window
      await page.goto('/manual/');
      await content.locator('a', { hasText: 'Getting Started' }).first().click();
      await expect(content.locator('h1')).toContainText('Getting Started');
      expect(new URL(page.url()).pathname).toBe('/manual/user-manual/getting-started');

      // a page that does not exist
      await page.goto('/manual/user-manual/no-such-page');
      await expect(content.locator('h1')).toHaveText('Page not found');
    } finally {
      stopErrorMonitoring();
    }
  });
});

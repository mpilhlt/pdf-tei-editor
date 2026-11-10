/**
 * User manual navigation end-to-end tests
 *
 * Clicks the manual link in the access tokens dialog and checks that it opens
 * the linked section in the user manual drawer instead of GitHub, that the
 * dialog comes back when the drawer closes, that the footer's "Contents"
 * drop-up lists and navigates the page's headings, and that a heading's
 * "Copy link" button copies the section's manual link.
 *
 * @testCovers app/src/plugins/info.js
 * @testCovers app/src/templates/info-drawer.html
 * @testCovers app/src/modules/manual-links.js
 * @testCovers app/src/modules/markdown-toc.js
 * @testCovers app/src/templates/access-tokens-dialog.html
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

/**
 * Scroll position of the drawer body and the offset of a heading from its top
 * @param {Page} page
 * @param {string} anchor - Heading id
 * @returns {Promise<{scrollTop: number, offset: number}>}
 */
async function headingPosition(page, anchor) {
  return page.evaluate(id => {
    const drawer = /** @type {any} */ (window).ui.infoDrawer;
    const body = drawer.shadowRoot.querySelector('[part="body"]');
    const heading = drawer.content.querySelector(`[id="${id}"]`);
    return {
      scrollTop: body.scrollTop,
      offset: Math.abs(heading.getBoundingClientRect().top - body.getBoundingClientRect().top)
    };
  }, anchor);
}

test.describe('User manual navigation', () => {

  test('manual links open the manual at the section; TOC and heading links work', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await page.evaluate(() => {
        const menuItem = document.querySelector('sl-menu-item[name="accessTokensMenuItem"]');
        if (!(menuItem instanceof HTMLElement)) throw new Error('Access Tokens menu item not found');
        menuItem.click();
      });
      const dialog = page.locator('sl-dialog[name="accessTokensDialog"]');
      await expect(dialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);

      // the link in the dialog opens the manual, not a new tab, and hides the dialog
      const popups = [];
      page.on('popup', popup => popups.push(popup));
      await dialog.locator('a', { hasText: 'see the examples' }).click();
      const drawer = page.locator('sl-drawer[name="infoDrawer"]');
      await expect(drawer).toHaveAttribute('open', '');
      await expect(dialog).not.toHaveAttribute('open', '');
      await expect(drawer.locator('#programmatic-api-access')).toBeAttached();
      await expect.poll(async () => (await headingPosition(page, 'programmatic-api-access')).offset).toBeLessThan(40);
      expect(popups).toHaveLength(0);

      // the TOC lists the page's headings and scrolls to the chosen one
      await drawer.locator('sl-button[name="tocBtn"]').click();
      const menu = drawer.locator('sl-menu[name="tocMenu"]');
      await expect(menu).toBeVisible();
      await expect(menu.locator('sl-menu-item', { hasText: 'Calling the API with an access token' })).toBeVisible();
      await menu.locator('sl-menu-item', { hasText: 'Best Practices' }).click();
      await expect.poll(async () => (await headingPosition(page, 'best-practices')).offset).toBeLessThan(40);

      // the heading's link button copies the manual link of the section
      await page.evaluate(() => {
        /** @type {any} */ (window).copiedText = null;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (/** @type {string} */ text) => { /** @type {any} */ (window).copiedText = text; } }
        });
      });
      const heading = drawer.locator('#best-practices');
      await heading.hover();
      await heading.locator('sl-icon-button.heading-link').click();
      const copied = await page.evaluate(() => /** @type {any} */ (window).copiedText);
      expect(copied).toMatch(/^https:\/\/github\.com\/mpilhlt\/pdf-tei-editor\/blob\/[^/]+\/docs\/development\/api-reference\.md#best-practices$/);

      // the edit button is in the header, the version next to it
      await expect(drawer.locator('sl-icon-button[data-name="editGitHubBtn"]')).toBeVisible();

      // closing the manual brings the dialog back
      await drawer.locator('sl-button[name="closeBtn"]').click();
      await expect(drawer).not.toHaveAttribute('open', '');
      await expect(dialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="closeBtn"]').click();
      await expect(dialog).not.toHaveAttribute('open', '');
    } finally {
      stopErrorMonitoring();
      await performLogout(page);
    }
  });
});

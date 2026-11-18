/**
 * PDF viewer no-match message end-to-end tests
 *
 * Checks that a PDF text search without a match shows its message in the PDF
 * viewer statusbar next to the Autosearch switch, not as a toast, and that the
 * message is removed again after 5 seconds.
 *
 * @testCovers app/src/plugins/pdfviewer.js
 * @testCovers app/src/plugins/services.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

const MESSAGE = 'No sufficiently similar text found in the PDF';

test.describe('PDF viewer no-match message', () => {

  test('shows the message in the statusbar and hides it after 5 seconds', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);

      // Search for a text in /TEI/text that does not occur in the PDF
      await page.evaluate(async () => {
        const doc = new DOMParser().parseFromString(
          '<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><p>qzxv wjkq pfzx vbnq mlkj zzqx ywqv</p></text></TEI>',
          'application/xml'
        );
        const node = /** @type {Element} */ (doc.getElementsByTagNameNS('http://www.tei-c.org/ns/1.0', 'p')[0]);
        await /** @type {any} */ (window).app.getDependency('services').searchNodeContentsInPdf(node);
      });

      const message = page.locator('#pdf-viewer status-bar status-text[name="statusMessage"]');
      await expect(message).toHaveAttribute('text', MESSAGE);
      await expect(message).toHaveAttribute('variant', 'warning');

      // Placed directly after the Autosearch switch
      const precededBySwitch = await message.evaluate(el => {
        const bar = /** @type {any} */ (el.parentElement);
        const ids = bar.positions.left.map(/** @param {{id: string}} w */ w => w.id);
        const switchEl = bar.querySelector('[name="searchSwitch"]');
        return ids.indexOf(el.id) === ids.indexOf(switchEl.id) + 1;
      });
      expect(precededBySwitch).toBe(true);

      // No toast
      expect(await page.locator('sl-alert', { hasText: MESSAGE }).count()).toBe(0);

      // Removed after 5 seconds
      await expect(message).toHaveCount(0, { timeout: 7000 });
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});

/**
 * Tools action "Write text corrections to PDF": for a document without text layout, the dialog
 * shows why nothing can be written and offers no Write button. The apply path is tested with the
 * preview and apply routes mocked (the real write needs the GROBID service and is covered by the
 * backend tests).
 *
 * @testCovers app/src/plugins/text-corrections.js
 * @testCovers app/src/modules/text-corrections.js
 * @testCovers fastapi_app/routers/ocr.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

const MARKER = '<!-- TEXT_CORRECTIONS_MARKER -->';

/**
 * Load the fixture document into the editor.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} its stable_id
 */
async function loadFixtureDocument(page) {
  const stableId = await page.evaluate(async () => {
    const result = await /** @type {any} */ (window).client.apiClient.filesList();
    const group = result.files.find((/** @type {any} */ f) => f.doc_id === 'document-rules-fixture');
    return group ? group.source.id : null;
  });
  expect(stableId).toBeTruthy();
  await page.evaluate(
    (id) => /** @type {any} */ (window).app.getDependency('services').load({ xml: id }),
    stableId
  );
  await page.waitForFunction(() => {
    const view = /** @type {any} */ (window).app.getDependency('xmleditor').getView();
    return view && view.state.doc.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(500);
  return stableId;
}

/**
 * Choose the "Write text corrections to PDF" item of the Tools menu.
 * @param {import('@playwright/test').Page} page
 */
async function clickMenuItem(page) {
  await page.click('sl-dropdown[name="toolsDropdown"] sl-button[name="toolsBtn"]');
  await page.waitForTimeout(500);
  const item = page.locator('sl-menu-item:has-text("Write text corrections to PDF")');
  await item.waitFor({ state: 'visible', timeout: 15000 });
  await item.click();
}

test.describe('Text corrections', () => {
  test('text corrections dialog shows the reason and no Write button without layout', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await loadFixtureDocument(page);
      await clickMenuItem(page);

      const opened = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_DIALOG_OPENED', 20000);
      expect(opened.value.canApply).toBe(false);

      const dialog = page.locator('sl-dialog[name="textCorrectionsDialog"]');
      await expect(dialog).toHaveAttribute('open', '');
      await expect(dialog.locator('[name="summary"]')).not.toBeEmpty();
      await expect(dialog.locator('sl-button[name="write"]')).toBeHidden();

      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="close"]').click();
      await expect(dialog).not.toHaveAttribute('open', '');
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });

  test('writing the corrections saves the returned TEI as a new version and leaves the old one unchanged', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string|null} */
    let newFileId = null;

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const stableId = await loadFixtureDocument(page);

      const originalXml = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getXML());
      const correctedXml = originalXml.replace(/(<\/[^>]+>)\s*$/, `${MARKER}$1`);
      expect(correctedXml).not.toBe(originalXml);

      await page.route('**/api/v1/ocr/text-corrections/preview', route => route.fulfill({
        json: {
          corrections: [{ page: 0, line: 3, old: 'teh', new: 'the' }],
          unwritable: [],
          affected_files: [],
          reason: null
        }
      }));
      await page.route('**/api/v1/ocr/text-corrections/apply', route => route.fulfill({
        json: { xml: correctedXml, pdf_stable_id: 'mock-pdf', archived_stable_id: null, corrections: 1 }
      }));

      await clickMenuItem(page);
      const opened = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_DIALOG_OPENED', 20000);
      expect(opened.value.canApply).toBe(true);

      const dialog = page.locator('sl-dialog[name="textCorrectionsDialog"]');
      await expect(dialog.locator('[name="corrections"] li')).toHaveText(['Page 1 · teh → the']);
      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="write"]').click();

      const applied = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_APPLIED', 30000);
      newFileId = applied.value.newFileId;
      expect(newFileId).toBeTruthy();
      expect(newFileId).not.toBe(stableId);
      expect(applied.value.corrections).toBe(1);

      const stored = await page.evaluate(async ({ oldId, newId }) => {
        // the XML route is not JSON, so apiClient.files() cannot be used; this is the URL the editor loads documents from
        const text = async (/** @type {string} */ id) => (await fetch(`/api/files/${id}`)).text();
        return { oldContent: await text(oldId), newContent: await text(newId) };
      }, { oldId: stableId, newId: newFileId });
      expect(stored.newContent).toContain('TEXT_CORRECTIONS_MARKER');
      expect(stored.oldContent).not.toContain('TEXT_CORRECTIONS_MARKER');

      // the new version is loaded in the editor
      const state = await page.evaluate(() => ({
        xml: /** @type {any} */ (window).app.getCurrentState().xml,
        content: /** @type {any} */ (window).app.getDependency('xmleditor').getXML()
      }));
      expect(state.xml).toBe(newFileId);
      expect(state.content).toContain('TEXT_CORRECTIONS_MARKER');
    } finally {
      if (newFileId) {
        await releaseAllLocks(page);
        await page.evaluate(async (id) => {
          await /** @type {any} */ (window).client.apiClient.filesDelete({ files: [id] });
        }, newFileId).catch(() => {});
      }
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });
});

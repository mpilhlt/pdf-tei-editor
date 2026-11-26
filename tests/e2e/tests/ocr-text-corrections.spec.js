/**
 * Tools action "Write text corrections to PDF": for a document without text layout, the dialog
 * shows why nothing can be written and offers no Write button. The apply path is tested with the
 * preview and apply routes mocked (the real write needs the GROBID service and is covered by the
 * backend tests): the client shows the busy state and loads the new version and the PDF.
 *
 * @testCovers app/src/plugins/text-corrections.js
 * @testCovers app/src/modules/text-corrections.js
 * @testCovers fastapi_app/routers/ocr.py
 */

import fs from 'fs';
import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

const SCANNED_PDF = 'tests/e2e/fixtures/pdf/scanned-document.pdf';

const MARKER = '<!-- TEXT_CORRECTIONS_MARKER -->';

/**
 * Create a document of its own (a PDF with unique content and a TEI version), so that the test does
 * not depend on, or change, fixtures that other specs use, and load it into the editor.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{stableId: string, pdfId: string, docId: string}>} stable_id of the TEI version and of the PDF, and the doc_id
 */
async function createOwnDocument(page) {
  const unique = `text-corrections-${Date.now()}`;
  const buffer = Buffer.concat([fs.readFileSync(SCANNED_PDF), Buffer.from(`\n%${unique}\n`)]);
  const fileChooserPromise = page.waitForEvent('filechooser');
  const uploadPromise = page.evaluate(() => /** @type {any} */ (window).client.uploadFile());
  await (await fileChooserPromise).setFiles({ name: `${unique}.pdf`, mimeType: 'application/pdf', buffer });
  const upload = await uploadPromise;
  const pdfId = upload.filename;
  expect(pdfId).toBeTruthy();

  const xml = `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>${unique}</title></titleStmt><publicationStmt><p/></publicationStmt><sourceDesc><p/></sourceDesc></fileDesc></teiHeader><text><body><p>teh text</p></body></text></TEI>`;
  const { stableId, docId } = await page.evaluate(async ({ pdfId, xml }) => {
    const client = /** @type {any} */ (window).client;
    const list = await client.apiClient.filesList();
    const group = list.files.find((/** @type {any} */ f) => f.source?.id === pdfId);
    const saved = await client.apiClient.filesSave({ xml_string: xml, file_id: group.doc_id, new_version: true });
    await client.apiClient.filesReleaseLock({ file_id: saved.file_id });
    return { stableId: saved.file_id, docId: group.doc_id };
  }, { pdfId, xml });
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
  return { stableId, pdfId, docId };
}

/**
 * Delete the files a test created.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} ids
 */
async function cleanUp(page, ids) {
  await releaseAllLocks(page);
  await page.evaluate(async (ids) => {
    const api = /** @type {any} */ (window).client.apiClient;
    for (const id of ids) await api.filesDelete({ files: [id] }).catch(() => {});
  }, ids).catch(() => {});
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

    /** @type {string[]} */
    const created = [];
    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
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
      await cleanUp(page, created);
    }
  });

  test('after writing the corrections, the new version and the corrected PDF are loaded', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const { stableId, pdfId, docId } = await createOwnDocument(page);
      created.push(stableId, pdfId);

      // the version the backend creates when it writes the corrections (the real write needs the
      // GROBID service and is covered by the backend tests). It is made without a parent, so that the
      // loaded version is not frozen (its drift check would fail)
      const originalXml = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getXML());
      const correctedXml = originalXml.replace(/(<\/[^>]+>)\s*$/, `${MARKER}$1`);
      expect(correctedXml).not.toBe(originalXml);
      const newVersionId = await page.evaluate(async ({ docId, xml }) => {
        const api = /** @type {any} */ (window).client.apiClient;
        const saved = await api.filesSave({ xml_string: xml, file_id: docId, new_version: true });
        await api.filesReleaseLock({ file_id: saved.file_id });
        return saved.file_id;
      }, { docId, xml: correctedXml });
      created.push(newVersionId);
      expect(newVersionId).not.toBe(stableId);

      await page.route('**/api/v1/ocr/text-corrections/preview', route => route.fulfill({
        json: {
          corrections: [{ page: 0, line: 3, old: 'teh', new: 'the' }],
          unwritable: [],
          reason: null
        }
      }));
      // delayed, so that the dialog's busy state can be seen
      await page.route('**/api/v1/ocr/text-corrections/apply', async route => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await route.fulfill({
          json: { xml: correctedXml, tei_stable_id: newVersionId, pdf_stable_id: pdfId, source_pdf_stable_id: pdfId, corrections: 1 }
        });
      });

      await clickMenuItem(page);
      const opened = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_DIALOG_OPENED', 20000);
      expect(opened.value.canApply).toBe(true);

      const dialog = page.locator('sl-dialog[name="textCorrectionsDialog"]');
      await expect(dialog.locator('[name="corrections"] li')).toHaveText(['Page 1 · teh → the']);
      const pdfLoadsBefore = consoleLogs.filter(log => log.message === 'PDF_SHOWN' && log.value?.pdf === pdfId).length;
      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="write"]').click();

      // the dialog stays open, with the Write button in loading state, while the request runs
      await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_WRITING', 10000);
      await expect(dialog).toHaveAttribute('open', '');
      await expect(dialog.locator('sl-button[name="write"]')).toHaveAttribute('loading', '');

      const applied = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_APPLIED', 30000);
      expect(applied.value.newFileId).toBe(newVersionId);
      expect(applied.value.corrections).toBe(1);
      await expect(dialog).not.toHaveAttribute('open', '');

      // the new version is loaded in the editor, and the PDF is loaded again although its stable_id is the same
      const state = await page.evaluate(() => ({
        xml: /** @type {any} */ (window).app.getCurrentState().xml,
        pdf: /** @type {any} */ (window).app.getCurrentState().pdf,
        content: /** @type {any} */ (window).app.getDependency('xmleditor').getXML()
      }));
      expect(state.xml).toBe(newVersionId);
      expect(state.pdf).toBe(pdfId);
      expect(state.content).toContain('TEXT_CORRECTIONS_MARKER');
      const pdfLoadsAfter = consoleLogs.filter(log => log.message === 'PDF_SHOWN' && log.value?.pdf === pdfId).length;
      expect(pdfLoadsAfter).toBe(pdfLoadsBefore + 1);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });
});

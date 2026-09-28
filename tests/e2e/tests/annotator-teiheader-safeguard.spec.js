/**
 * Annotator teiHeader safeguard E2E tests.
 *
 * A pure annotator (annotator role, no reviewer/admin) gets a UI-only safeguard:
 * the teiHeader toggle switch is hidden, the header is folded by default, and
 * typing inside teiHeader is rejected in the CodeMirror UI - while remaining
 * fully writable programmatically (not tested here; see the spec) and remaining
 * manually unfoldable via the fold gutter.
 *
 * @testCovers app/src/plugins/tei-tools.js
 * @testCovers app/src/modules/xmleditor.js
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/modules/acl-utils.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';
import { debugLog } from './helpers/debug-helpers.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'offsetParent is not set.*cannot scroll',
  'Failed to load resource.*403.*FORBIDDEN',
  'Failed to load resource.*423.*LOCKED',
];

// Strings unique to the fixture's <teiHeader>/<text> respectively (see
// tests/e2e/fixtures/standard/files/tei/example/10.5771__2699-1284-2024-3-149.tei.xml).
const HEADER_ONLY_TEXT = 'Christian Boulanger';
const BODY_ONLY_TEXT = 'A key aspect of many Digital Humanities projects';

/**
 * selectFirstDocuments() auto-loads the PDF's gold TEI (see extraction-helper.js).
 * Gold is read-only for a pure annotator (requires the reviewer role), and the
 * standard E2E fixture set seeds gold-only documents (no version artifacts), so
 * there is no editable document to select. This feature only applies to editable
 * (version) documents, so create one: save the currently loaded gold content as a
 * new version via the API directly (annotators can create versions - see
 * fastapi_app/routers/files_save.py) and load it into the editor.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} the new version's stable id
 */
async function loadEditableAnnotatorVersion(page) {
  const xmlString = await page.evaluate(() =>
    /** @type {any} */ (window).app.getDependency('xmleditor').getXML()
  );
  const stableId = await page.evaluate(async (xml_string) => {
    const res = await /** @type {any} */ (window).client.apiClient.filesSave({
      xml_string,
      file_id: 'annotator-teiheader-safeguard-probe',
      new_version: true
    });
    return res.file_id;
  }, xmlString);
  await page.evaluate(
    (id) => /** @type {any} */ (window).app.getDependency('services').load({ xml: id }),
    stableId
  );
  await page.waitForFunction((expectedXml) => {
    /** @type {any} */
    const app = /** @type {any} */ (window).app;
    return app.getCurrentState().xml === expectedXml && app.getCurrentState().editorReadOnly === false;
  }, stableId, { timeout: 20000 });
  return stableId;
}

test.describe('Annotator teiHeader safeguard', () => {

  test('Annotator: teiHeader toggle is hidden and header is folded by default', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      const toggleState = await page.evaluate(() => {
        /** @type {any} */
        const ui = /** @type {any} */ (window).ui;
        const widget = ui.xmlEditor.toolbar.teiHeaderToggleWidget;
        return { display: getComputedStyle(widget).display };
      });
      debugLog('teiHeader toggle state for annotator:', toggleState);
      expect(toggleState.display).toBe('none');

      // Header content is folded away by default; body text is visible.
      await expect(page.locator('#codemirror-container .cm-content')).not.toContainText(HEADER_ONLY_TEXT);
      await expect(page.locator('#codemirror-container .cm-content')).toContainText(BODY_ONLY_TEXT);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('Reviewer: teiHeader toggle remains visible (regression)', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      const toggleState = await page.evaluate(() => {
        /** @type {any} */
        const ui = /** @type {any} */ (window).ui;
        const widget = ui.xmlEditor.toolbar.teiHeaderToggleWidget;
        return { display: getComputedStyle(widget).display };
      });
      debugLog('teiHeader toggle state for reviewer:', toggleState);
      expect(toggleState.display).not.toBe('none');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('Annotator: typing inside teiHeader is rejected', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);
      await loadEditableAnnotatorVersion(page);

      // Manually unfold the header via the editor API - simulates using the fold
      // gutter directly, bypassing the (hidden) toggle switch, per spec.
      await page.evaluate(() => {
        /** @type {any} */ (window).app.getDependency('xmleditor').unfoldByXpath('//tei:teiHeader');
      });
      await page.waitForTimeout(300);
      await expect(page.locator('#codemirror-container .cm-content')).toContainText(HEADER_ONLY_TEXT);

      const docBefore = await page.evaluate(() =>
        /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString()
      );

      // Place the cursor inside <teiHeader> and type - must be rejected.
      await page.evaluate(() => {
        const xmlEditor = /** @type {any} */ (window).app.getDependency('xmleditor');
        const view = xmlEditor.getView();
        const headerNode = xmlEditor.getSyntaxNodeByXpath('//tei:teiHeader');
        const pos = Math.floor((headerNode.from + headerNode.to) / 2);
        view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
      });
      await page.locator('#codemirror-container .cm-content').focus();
      await page.keyboard.type('ZZZ');
      await page.waitForTimeout(300);

      const docAfterHeaderTyping = await page.evaluate(() =>
        /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString()
      );
      expect(docAfterHeaderTyping).toBe(docBefore);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('Annotator: typing inside <text> is applied', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);
      await loadEditableAnnotatorVersion(page);

      const docBefore = await page.evaluate(() =>
        /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString()
      );

      // Place the cursor inside <text> and type - must be applied (the guard
      // only affects teiHeader; regular annotator editing must keep working).
      await page.evaluate(() => {
        const xmlEditor = /** @type {any} */ (window).app.getDependency('xmleditor');
        const view = xmlEditor.getView();
        const textNode = xmlEditor.getSyntaxNodeByXpath('//tei:text');
        const pos = Math.floor((textNode.from + textNode.to) / 2);
        view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
      });
      await page.locator('#codemirror-container .cm-content').focus();
      await page.keyboard.type('ZZZ');
      await page.waitForTimeout(300);

      const docAfterTextTyping = await page.evaluate(() =>
        /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString()
      );
      expect(docAfterTextTyping).not.toBe(docBefore);
      expect(docAfterTextTyping).toContain('ZZZ');
    } finally {
      // The typed edit only reaches a local (browser-storage) draft, never the
      // server (see xmleditor.js's #scheduleDraftSave/#flushDraftNow) - no
      // server-side cleanup is needed before releasing the lock.
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

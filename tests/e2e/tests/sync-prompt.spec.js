/**
 * Sync prompt end-to-end tests
 *
 * Registers a sync source whose diagnostics name a page (as the GROBID plugin's feature file check
 * does), makes an edit that adds such a diagnostic, and checks that reviewers are asked to
 * synchronize: "Synchronize" writes the text corrections of the page, "Show changes" lists only
 * the sync diagnostics in the diagnostics drawer, and "Don't ask again" turns the prompt off for
 * the document. Diagnostics there before the first edit are asked about once, with another text.
 * The drawer lists the sync diagnostics in their own section, unchecked, with "Revert to PDF text"
 * and a "Write to PDF" button.
 *
 * @testCovers app/src/plugins/sync-prompt.js
 * @testCovers app/src/modules/sync-prompt.js
 * @testCovers app/src/plugins/diagnostics-drawer.js
 * @testCovers app/src/templates/sync-prompt-dialog.html
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure, waitForTestMessage } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

const SOURCE = 'e2e-sync';

/**
 * Loads an editable copy (a new version) of the document loaded by selectFirstDocuments().
 * @param {Page} page
 * @returns {Promise<void>}
 */
async function loadEditableVersion(page) {
  const stableId = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const res = await w.client.apiClient.filesSave({
      xml_string: w.app.getDependency('xmleditor').getXML(),
      file_id: w.app.getCurrentState().xml,
      new_version: true
    });
    await w.client.apiClient.filesReleaseLock({ file_id: res.file_id });
    await w.app.getDependency('services').load({ xml: res.file_id });
    return res.file_id;
  });
  await page.waitForFunction((expectedXml) => {
    const app = /** @type {any} */ (window).app;
    return app.getCurrentState().xml === expectedXml && app.getCurrentState().editorReadOnly === false;
  }, stableId, { timeout: 20000 });
}

/**
 * Registers the sync source `e2e-sync`: a warning on page `n - 1` at every `SYNC<n>` in the
 * document, and one diagnostic of another source. Re-merged after every change.
 * Also replaces `writePages()` of the text-corrections plugin by a stub recording its pages.
 * @param {Page} page
 * @returns {Promise<void>}
 */
async function registerSyncSource(page) {
  await page.evaluate((source) => {
    const w = /** @type {any} */ (window);
    const lintUtils = w.app.getDependency('lint-utils');
    const xmleditor = w.app.getDependency('xmleditor');
    lintUtils.registerSyncSource(source, { target: 'test training data' });
    w.writtenPages = [];
    w.app.getDependency('text-corrections').writePages = async (/** @type {number[]} */ pages) => {
      w.writtenPages.push(pages);
      return 'written';
    };
    let rendering = false;
    const render = () => {
      const text = xmleditor.getView().state.doc.toString();
      const own = Array.from(text.matchAll(/SYNC(\d+)/g)).map(m => ({
        from: m.index, to: m.index + m[0].length, severity: 'warning', message: `Sync: unexpected token "${m[0]}"`, page: Number(m[1]) - 1, replacement: ''
      }));
      rendering = true;
      try {
        lintUtils.applyMergedDiagnostics(xmleditor.getView(), source, own);
        lintUtils.applyMergedDiagnostics(xmleditor.getView(), 'e2e-other', [{ from: 0, to: 4, severity: 'warning', message: 'not a sync diagnostic' }]);
      } finally {
        rendering = false;
      }
    };
    xmleditor.addUpdateListener((/** @type {any} */ update) => {
      if ((update.docChanged || lintUtils.replacesDiagnostics(update)) && !rendering) setTimeout(render, 0);
    });
    render();
  }, SOURCE);
}

/**
 * Types `text` before `<body` as the user would.
 * @param {Page} page
 * @param {string} text
 */
async function typeBeforeBody(page, text) {
  await page.evaluate((text) => {
    const view = /** @type {any} */ (window).app.getDependency('xmleditor').getView();
    const at = view.state.doc.toString().indexOf('<body');
    view.dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' });
  }, text);
}

/**
 * Checks for new sync diagnostics now; resolves with the choice once the prompt is closed, or
 * null right away if it was not shown. Not awaited by the caller while the prompt is shown.
 * @param {Page} page
 */
function checkNow(page) {
  return page.evaluate(() => /** @type {any} */ (window).app.getDependency('sync-prompt').check());
}

/**
 * Clicks a button of the sync prompt dialog.
 * @param {Page} page
 * @param {string} name
 */
async function clickDialog(page, name) {
  await page.waitForTimeout(500);
  await page.locator(`sl-dialog[name="syncPromptDialog"] [name="${name}"]`).first().click();
}

/**
 * The messages listed in the drawer (`messages`: the main list, `sync`: the "Differences from the
 * PDF" section) and whether its filter button is shown.
 * @param {Page} page
 */
async function drawer(page) {
  return page.evaluate(() => {
    const d = /** @type {any} */ (window).ui.pdfViewer.diagnosticsDrawer;
    /** @param {HTMLElement} list */
    const messages = list => Array.from(list.children).map((/** @type {HTMLElement} */ item) => item.querySelector('.diagnostics-drawer-message')?.textContent ?? '');
    return {
      messages: messages(d.list),
      sync: d.syncGroup.hidden ? [] : messages(d.syncGroup.syncList),
      filtered: !d.header.filterButton.hidden
    };
  });
}

/**
 * Whether the entries of the sync section are checked, and the labels of their fix buttons.
 * @param {Page} page
 */
async function syncEntries(page) {
  return page.evaluate(() => {
    const d = /** @type {any} */ (window).ui.pdfViewer.diagnosticsDrawer;
    return Array.from(d.syncGroup.syncList.children).map((/** @type {HTMLElement} */ item) => ({
      checked: /** @type {any} */ (item.querySelector('sl-checkbox')).checked,
      fix: item.querySelector('.diagnostics-drawer-apply-fix')?.textContent ?? null
    }));
  });
}

test.describe('Sync prompt', () => {

  test('asks reviewers to synchronize new sync diagnostics', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadEditableVersion(page);
      await page.evaluate(() => /** @type {any} */ (window).app.getDependency('sync-prompt').uiStorage.remove('dontAskDocuments'));
      await registerSyncSource(page);

      // diagnostics present before the first edit are asked about once, as differences from the PDF
      await page.evaluate(() => {
        const view = /** @type {any} */ (window).app.getDependency('xmleditor').getView();
        const at = view.state.doc.toString().indexOf('<body');
        view.dispatch({ changes: { from: at, insert: 'SYNC9 ' } });
      });
      await expect.poll(async () => (await drawer(page)).sync).toEqual(['Sync: unexpected token "SYNC9"']);
      // in their own section, unchecked, with a fix that reverts the change
      expect((await drawer(page)).messages).toContain('not a sync diagnostic');
      expect(await syncEntries(page)).toEqual([{ checked: false, fix: 'Revert to PDF text' }]);
      const atLoad = await waitForTestMessage(consoleLogs, 'SYNC_PROMPT_OPENED', 10000);
      expect(atLoad.value).toEqual({ pages: [8], count: 1, reason: 'load' });
      await expect(page.locator('sl-dialog[name="syncPromptDialog"] [name="message"]'))
        .toHaveText('The text of this document differs from the PDF in 1 place (page 9). If these differences are intended, for example corrections that were not written into the PDF yet, the PDF text layer and the test training data need to be updated to match.');
      await clickDialog(page, 'notNow');
      const closedAtLoad = await waitForTestMessage(consoleLogs, 'SYNC_PROMPT_CLOSED', 10000);
      expect(closedAtLoad.value.choice).toBe('cancel');
      expect(await checkNow(page)).toBeNull();
      // Select all leaves the sync diagnostics out
      await page.locator('sl-drawer[name="diagnosticsDrawer"] sl-checkbox[name="selectAll"]').click();
      expect(await syncEntries(page)).toEqual([{ checked: false, fix: 'Revert to PDF text' }]);
      await page.locator('sl-drawer[name="diagnosticsDrawer"] sl-checkbox[name="selectAll"]').click();

      // an edit adding a sync diagnostic opens it after the delay; Synchronize writes its page
      await typeBeforeBody(page, 'SYNC2 ');
      // the second prompt, after the one at load
      const openedPrompts = () => consoleLogs.filter(log => log.message === 'SYNC_PROMPT_OPENED');
      await expect.poll(() => openedPrompts().length, { timeout: 10000 }).toBe(2);
      expect(openedPrompts()[1].value).toEqual({ pages: [1], count: 1, reason: 'edit' });
      await expect(page.locator('sl-dialog[name="syncPromptDialog"] [name="message"]'))
        .toHaveText('You changed the text of this document. If the changes are intentional, the PDF text layer and the test training data need to be updated to match.');
      await clickDialog(page, 'synchronize');
      await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).writtenPages)).toEqual([[1]]);

      // the same diagnostic does not ask again; Show changes filters the drawer
      expect(await checkNow(page)).toBeNull();
      await typeBeforeBody(page, 'SYNC4 ');
      const shown = checkNow(page);
      await clickDialog(page, 'showChanges');
      expect(await shown).toBe('show');
      await expect.poll(() => drawer(page)).toEqual({
        messages: [],
        sync: ['Sync: unexpected token "SYNC9"', 'Sync: unexpected token "SYNC2"', 'Sync: unexpected token "SYNC4"'],
        filtered: true
      });
      // Write to PDF writes the pages of all listed sync diagnostics
      await page.locator('sl-drawer[name="diagnosticsDrawer"] [name="syncAction"]').click();
      await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).writtenPages)).toEqual([[1], [1, 3, 8]]);
      await page.locator('[name="filterButton"]').click();
      await expect.poll(async () => (await drawer(page)).messages).toContain('not a sync diagnostic');
      expect((await drawer(page)).filtered).toBe(false);

      // Don't ask again turns the prompt off for the document
      await typeBeforeBody(page, 'SYNC5 ');
      const cancelled = checkNow(page);
      await page.waitForTimeout(500);
      await page.locator(`sl-dialog[name="syncPromptDialog"] [name="dontAsk"]`).first().click();
      await clickDialog(page, 'notNow');
      expect(await cancelled).toBe('cancel');
      await typeBeforeBody(page, 'SYNC6 ');
      expect(await checkNow(page)).toBeNull();
      expect(await page.evaluate(() => /** @type {any} */ (window).app.getDependency('sync-prompt').isOffForDocument())).toBe(true);
      expect(await page.evaluate(() => /** @type {any} */ (window).writtenPages)).toEqual([[1], [1, 3, 8]]);
    } finally {
      await page.evaluate(() => /** @type {any} */ (window).app.getDependency('sync-prompt').uiStorage.remove('dontAskDocuments')).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

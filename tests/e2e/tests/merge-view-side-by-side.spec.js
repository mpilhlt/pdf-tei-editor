/**
 * Side-by-side diff window end-to-end tests
 *
 * Opens the read-only side-by-side diff window from the merge view toolbar, checks that it shows
 * both documents, follows edits in the editor and closes when the merge view is hidden.
 *
 * @testCovers app/src/plugins/merge-view.js
 * @testCovers app/src/modules/side-by-side-diff-window.js
 * @testCovers app/src/modules/xmleditor.js
 * @testCovers app/src/templates/merge-view-toolbar.html
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

test.describe('Side-by-side diff window', () => {

  test('opens from the merge view, follows edits and closes with the merge view', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      // the document may be read-only (gold): the window is read-only as well and works without
      // edit rights; programmatic changes below are not blocked by the read-only filter
      await page.waitForFunction(() => /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.length > 0, null, { timeout: 20000 });

      const button = page.locator('[name="sideBySideBtn"]');
      // without a merge view the button is disabled
      expect(await button.evaluate(el => /** @type {any} */ (el).disabled)).toBe(true);

      await page.evaluate(async () => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        await xmleditor.showMergeView(xmleditor.getView().state.doc.toString().replace('<teiHeader', '<!--INCOMING--><teiHeader'));
      });
      await expect.poll(() => button.evaluate(el => /** @type {any} */ (el).disabled)).toBe(false);

      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        button.click()
      ]);
      const editors = popup.locator('.cm-mergeView .cm-editor');
      await expect(editors).toHaveCount(2);
      // compared version on the left, open document on the right
      await expect(editors.nth(0).locator('.cm-content')).toContainText('<!--INCOMING-->');
      await expect(editors.nth(1).locator('.cm-content')).not.toContainText('<!--INCOMING-->');
      await expect(popup.locator('.cm-changedLine').first()).toBeAttached();
      // read-only
      expect(await editors.nth(0).locator('.cm-content').getAttribute('contenteditable')).toBe('false');
      expect(await editors.nth(1).locator('.cm-content').getAttribute('contenteditable')).toBe('false');

      // scrolling renders the lines that come into view
      await popup.locator('.sbs-diff').evaluate(el => { el.scrollTop = el.scrollHeight });
      await expect(editors.nth(0).locator('.cm-content')).toContainText('</TEI>');
      await expect(editors.nth(1).locator('.cm-content')).toContainText('</TEI>');
      await popup.locator('.sbs-diff').evaluate(el => { el.scrollTop = 0 });

      // "Sync with editor" (checked by default): scrolling the editor scrolls the window to the same
      // line of the current document, and scrolling the window scrolls the editor
      const windowTopLine = () => popup.locator('.sbs-diff').evaluate(container => {
        const top = container.getBoundingClientRect().top;
        const right = container.querySelectorAll('.cm-editor')[1];
        const first = [...right.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
          .find(el => el.textContent && el.getBoundingClientRect().bottom > top + 1);
        return Number(first?.textContent);
      });
      await expect(popup.locator('input[name="syncScroll"]')).toBeChecked();
      // a line below the folded teiHeader
      const target = await page.evaluate(async () => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        const doc = xmleditor.getView().state.doc;
        const line = doc.lineAt(doc.toString().indexOf('<text ')).number + 3;
        xmleditor.scrollLineToTop(line);
        await new Promise(resolve => setTimeout(resolve, 100));
        return xmleditor.getTopVisibleLine();
      });
      expect(target).toBeGreaterThan(3);
      await expect.poll(windowTopLine).toBe(target);
      await popup.locator('.sbs-diff').evaluate(el => { el.scrollTop = Math.floor(el.scrollHeight / 3) });
      const lineAfterWindowScroll = await (async () => { await popup.waitForTimeout(300); return windowTopLine(); })();
      await expect.poll(() => page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getTopVisibleLine()))
        .toBe(lineAfterWindowScroll);
      // unchecked: the window does not follow the editor
      await popup.locator('input[name="syncScroll"]').uncheck();
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').scrollLineToTop(1));
      await popup.waitForTimeout(300);
      expect(await windowTopLine()).toBe(lineAfterWindowScroll);
      await popup.locator('input[name="syncScroll"]').check();
      await popup.locator('.sbs-diff').evaluate(el => { el.scrollTop = 0 });

      // edits in the editor are shown in the window
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        view.dispatch({ changes: { from: view.state.doc.toString().indexOf('<teiHeader'), insert: '<!--EDITED-->' } });
      });
      await expect(editors.nth(1).locator('.cm-content')).toContainText('<!--EDITED-->');

      // switching to another version keeps the window open
      await page.evaluate(async () => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        await xmleditor.showMergeView(xmleditor.getView().state.doc.toString().replace('<teiHeader', '<!--OTHER--><teiHeader'));
      });
      await expect(editors.nth(0).locator('.cm-content')).toContainText('<!--OTHER-->');
      expect(popup.isClosed()).toBe(false);

      // hiding the merge view closes the window
      await page.evaluate(async () => {
        await (/** @type {any} */ (window)).app.getDependency('xmleditor').hideMergeView();
      });
      await expect.poll(() => popup.isClosed()).toBe(true);

      // the Close button closes the window
      await page.evaluate(async () => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        await xmleditor.showMergeView(xmleditor.getView().state.doc.toString().replace('<teiHeader', '<!--INCOMING--><teiHeader'));
      });
      await expect.poll(() => button.evaluate(el => /** @type {any} */ (el).disabled)).toBe(false);
      const [popup2] = await Promise.all([
        page.waitForEvent('popup'),
        button.click()
      ]);
      await popup2.getByRole('button', { name: 'Close' }).click();
      await expect.poll(() => popup2.isClosed()).toBe(true);
      await page.evaluate(async () => {
        await (/** @type {any} */ (window)).app.getDependency('xmleditor').hideMergeView();
      });
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

/**
 * Bookmarks end-to-end tests
 *
 * As an annotator, bookmarks a <bibl> from the editor's context menu (the entry is disabled in
 * the teiHeader), opens the Bookmarks dialog from the user menu, renames the bookmark, opens it
 * (which selects the element, also after a unit was inserted before it), checks the gutter marker, checks that another
 * user does not see it, deletes it, and checks that deleting the document deletes its bookmarks.
 *
 * @testCovers app/src/plugins/bookmarks.js
 * @testCovers app/src/templates/bookmarks-dialog.html
 * @testCovers app/src/templates/bookmarks-menu-item.html
 * @testCovers app/src/modules/node-anchor.js
 * @testCovers app/src/modules/codemirror/bookmark-gutter.js
 * @testCovers app/src/modules/unit-review-popover.js
 * @testCovers fastapi_app/routers/bookmarks.py
 * @testCovers fastapi_app/lib/bookmarks/store.py
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

const TEXT = `<text>
    <listBibl>
      <bibl>Alpha 2001</bibl>
      <bibl>Beta 2002</bibl>
      <bibl>Gamma 2003</bibl>
    </listBibl>
  </text>`;

/**
 * Loads an editable copy of the first document with the test <text>.
 * @param {Page} page
 * @returns {Promise<string>} The stable id of the copy
 */
async function loadBookmarkDocument(page) {
  const stableId = await page.evaluate(async ({ text }) => {
    const w = /** @type {any} */ (window);
    const xml = w.app.getDependency('xmleditor').getXML()
      .replace(/<standOff[\s\S]*?<\/standOff>\s*/, '')
      .replace(/<text[\s>][\s\S]*<\/text>/, text);
    const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'bookmark-probe', new_version: true });
    await w.app.getDependency('services').load({ xml: res.file_id });
    return res.file_id;
  }, { text: TEXT });
  await page.waitForFunction((expectedXml) => {
    const app = /** @type {any} */ (window).app;
    return app.getCurrentState().xml === expectedXml && app.getCurrentState().editorReadOnly === false;
  }, stableId, { timeout: 20000 });
  return stableId;
}

/**
 * Scrolls a text of the editor into view and returns its screen point.
 * @param {Page} page
 * @param {string} needle
 * @returns {Promise<{x: number, y: number}>}
 */
async function pointOf(page, needle) {
  return page.evaluate(async (needle) => {
    const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
    const pos = view.state.doc.toString().indexOf(needle) + 2;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const coords = view.coordsAtPos(pos);
    return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
  }, needle);
}

/**
 * Opens the Bookmarks dialog from the user menu.
 * @param {Page} page
 */
async function openBookmarksDialog(page) {
  await page.locator('sl-dropdown[name="toolbarMenu"] sl-button[name="menuBtn"]').click();
  const item = page.getByTestId('bookmarks-menu-item');
  await expect(item).toBeVisible();
  await item.click();
  await page.waitForSelector('sl-dialog[name="bookmarksDialog"][open]');
  await page.waitForTimeout(500);
}

/**
 * @param {Page} page
 * @param {string} needle
 * @returns {Promise<number>} The line of a text in the editor
 */
async function lineOf(page, needle) {
  return page.evaluate((needle) => {
    const doc = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc;
    return doc.lineAt(doc.toString().indexOf(needle)).number;
  }, needle);
}

/**
 * @param {Page} page
 * @returns {Promise<string>} The selected text of the editor
 */
async function selectedText(page) {
  return page.evaluate(() => {
    const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
    const { from, to } = view.state.selection.main;
    return view.state.doc.sliceString(from, to);
  });
}

test.describe('Bookmarks', () => {

  test('users bookmark elements of the text and open them from the user menu', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string|null} */
    let bookmarkId = null;

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const stableId = await loadBookmarkDocument(page);

      // not available in the teiHeader
      const header = await pointOf(page, '<teiHeader');
      await page.mouse.click(header.x, header.y, { button: 'right' });
      const menuItem = page.getByTestId('bookmark-menu-item');
      await expect(menuItem).toBeVisible();
      await expect(menuItem).toHaveAttribute('disabled', '');
      await page.keyboard.press('Escape');

      // "Bookmark…" asks for a title, proposing the element's text
      const beta = await pointOf(page, 'Beta');
      await page.mouse.click(beta.x, beta.y, { button: 'right' });
      await expect(menuItem).toBeVisible();
      await expect(menuItem).not.toHaveAttribute('disabled', '');
      await menuItem.click();
      const prompt = page.getByTestId('bookmark-prompt');
      await expect(prompt).toBeVisible();
      await expect(prompt.locator('input')).toHaveValue('Beta 2002');
      await prompt.locator('input').fill('Second entry');
      await prompt.locator('input').press('Enter');
      const added = await waitForTestMessage(consoleLogs, 'BOOKMARK_ADDED');
      expect(added.value.path).toBe('/TEI/text/listBibl/bibl[2]');
      expect(added.value.title).toBe('Second entry');
      bookmarkId = added.value.id;

      // a marker in the gutter on the element's line
      const marker = page.getByTestId('bookmark-gutter-marker');
      await expect(marker).toHaveCount(1);
      await expect(marker).toHaveAttribute('title', 'Bookmark: Second entry');
      expect(await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('bookmarks').getDocumentBookmarks()))
        .toEqual([{ id: added.value.id, title: 'Second entry', line: await lineOf(page, '<bibl>Beta') }]);

      // bookmarks are not stored in the document
      const text = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).not.toContain('Second entry');

      // the list in the dialog, filtered to the open document
      await openBookmarksDialog(page);
      const dialog = page.locator('sl-dialog[name="bookmarksDialog"]');
      await expect(dialog.locator('sl-radio-group[name="scopeFilter"]')).toHaveJSProperty('value', 'document');
      const row = dialog.getByTestId('bookmark-row').filter({ hasText: 'Second entry' });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('<bibl>');
      await expect(row).toContainText('Beta 2002');

      // rename
      await row.getByTestId('bookmark-rename').click();
      const renameInput = row.getByTestId('bookmark-rename-input').locator('input');
      await renameInput.fill('Beta entry');
      await renameInput.press('Enter');
      await waitForTestMessage(consoleLogs, 'BOOKMARK_RENAMED');
      await expect(page.getByTestId('bookmark-gutter-marker')).toHaveAttribute('title', 'Bookmark: Beta entry');
      const renamed = dialog.getByTestId('bookmark-row').filter({ hasText: 'Beta entry' });
      await expect(renamed).toHaveCount(1);
      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="closeBtn"]').click();
      await expect(dialog).not.toHaveAttribute('open', '');

      // a new unit before the element: the bookmark still selects it
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const pos = view.state.doc.toString().indexOf('<bibl>Alpha');
        view.dispatch({ changes: { from: pos, insert: '<bibl>Zero 2000</bibl>\n      ' }, selection: { anchor: 0 } });
      });
      await openBookmarksDialog(page);
      await dialog.getByTestId('bookmark-row').filter({ hasText: 'Beta entry' }).click();
      const opened = await waitForTestMessage(consoleLogs, 'BOOKMARK_OPENED');
      expect(opened.value.found).toBe(true);
      expect(opened.value.match).toBe('session'); // tracked through the edit
      expect(await selectedText(page)).toBe('<bibl>Beta 2002</bibl>');

      // the gutter marker moved with the element; clicking it selects the element
      await expect.poll(async () => (await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('bookmarks').getDocumentBookmarks()))[0]?.line)
        .toBe(await lineOf(page, '<bibl>Beta'));
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().dispatch({ selection: { anchor: 0 } }));
      await page.getByTestId('bookmark-gutter-marker').click();
      await waitForTestMessage(consoleLogs, 'BOOKMARK_GUTTER_CLICKED');
      expect(await selectedText(page)).toBe('<bibl>Beta 2002</bibl>');

      // private: another user does not see it
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().dispatch({ selection: { anchor: 0 } }));
      const own = await page.evaluate(async (stableId) => (await (/** @type {any} */ (window)).client.apiClient.bookmarksList({ stable_id: stableId })).items.length, stableId);
      expect(own).toBe(1);
      await releaseAllLocks(page);
      await performLogout(page);
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const others = await page.evaluate(async () => (await (/** @type {any} */ (window)).client.apiClient.bookmarksList()).items.map((/** @type {any} */ b) => b.id));
      expect(others).not.toContain(bookmarkId);
      await performLogout(page);

      // delete
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      await openBookmarksDialog(page);
      const listed = dialog.locator(`[data-testid="bookmark-row"][data-id="${bookmarkId}"]`);
      await expect(listed).toHaveCount(1);
      await listed.getByTestId('bookmark-delete').click();
      await waitForTestMessage(consoleLogs, 'BOOKMARK_DELETED');
      await expect(listed).toHaveCount(0);
      bookmarkId = null;
      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="closeBtn"]').click();

      // deleting the document deletes its bookmarks
      const remaining = await page.evaluate(async (stableId) => {
        const api = (/** @type {any} */ (window)).client.apiClient;
        await api.bookmarksCreate({ stable_id: stableId, path: '/TEI/text/listBibl/bibl[1]', element: 'bibl', title: 'Gone with the file' });
        await api.filesDelete({ files: [stableId] });
        for (let i = 0; i < 40; i++) {
          const { items } = await api.bookmarksList({ stable_id: stableId });
          if (items.length === 0) return 0;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        return (await api.bookmarksList({ stable_id: stableId })).items.length;
      }, stableId);
      expect(remaining).toBe(0);
    } finally {
      if (bookmarkId) {
        await page.evaluate(async (id) => {
          try { await (/** @type {any} */ (window)).client.apiClient.bookmarksDelete(id); } catch { /* other user or gone */ }
        }, bookmarkId).catch(() => {});
      }
      await releaseAllLocks(page).catch(() => {});
      stopErrorMonitoring();
    }
  });
});

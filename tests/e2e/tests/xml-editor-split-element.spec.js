/**
 * Split element end-to-end test
 *
 * Right-clicks into the text of an element and splits it with the "Split <tag>" entry of the XML
 * editor's context menu. Checks that the entry is disabled inside a tag, that the second element
 * gets the attributes of the first one except xml:id, and that splitting works while the editor is
 * read-only for typing but the document is editable (as in the visual annotation mode), at the
 * right-clicked position. Holding Shift swaps in "Split <tag> in new line".
 *
 * @testCovers app/src/modules/codemirror/xml-editor-context-menu.js
 * @testCovers app/src/modules/codemirror/split-element.js
 */

/**
 * @import { Page } from '@playwright/test'
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

const TEXT = `<text>
    <body>
      <p xml:id="p1" n="1">First part Second part</p>
    </body>
  </text>`;

/**
 * Loads an editable copy of the first document with the test <text>.
 * @param {Page} page
 * @returns {Promise<string>} The stable id of the copy
 */
async function loadSplitDocument(page) {
  const stableId = await page.evaluate(async ({ text }) => {
    const w = /** @type {any} */ (window);
    const xml = w.app.getDependency('xmleditor').getXML()
      .replace(/<standOff[\s\S]*?<\/standOff>\s*/, '')
      .replace(/<text[\s>][\s\S]*<\/text>/, text);
    const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'split-probe', new_version: true });
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
 * Puts the cursor before a text of the editor and right-clicks there.
 * @param {Page} page
 * @param {string} needle
 * @param {number} [offset]
 */
async function rightClickAt(page, needle, offset = 0) {
  const point = await page.evaluate(async ([needle, offset]) => {
    const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
    const pos = view.state.doc.toString().indexOf(needle) + offset;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const coords = view.coordsAtPos(pos);
    return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
  }, /** @type {[string, number]} */ ([needle, offset]));
  await page.mouse.click(point.x, point.y, { button: 'right' });
}

test.describe('Split element', () => {

  test('splits the element that contains the cursor', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string|null} */
    let stableId = null;

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      stableId = await loadSplitDocument(page);

      const item = page.getByTestId('split-element-menu-item');

      // disabled inside a tag
      await rightClickAt(page, 'n="1"', 1);
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('disabled', '');
      await expect(item).toContainText('Split element');
      await page.keyboard.press('Escape');

      // splits the <p> at the cursor
      await rightClickAt(page, 'Second part');
      await expect(item).toBeVisible();
      await expect(item).not.toHaveAttribute('disabled', '');
      await expect(item).toContainText('Split <p>');
      await expect(item.locator('[slot="suffix"]')).toHaveText('⇧');
      await item.click();

      let text = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).toContain('<p xml:id="p1" n="1">First part </p><p n="1">Second part</p>');

      // like the visual annotation mode: the editor is read-only for typing, the document is
      // editable, and a right-click away from the cursor splits at the clicked position
      await page.evaluate(async () => {
        const xmlEditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        await xmlEditor.setReadOnly(true);
        xmlEditor.getView().dispatch({ selection: { anchor: 0 } });
      });
      const point = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('part </p>'));
        return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(point.x, point.y, { button: 'right' });
      await expect(item).toBeVisible();
      await expect(item).toContainText('Split <p>');
      await item.click();
      text = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).toContain('<p xml:id="p1" n="1">First </p><p n="1">part </p><p n="1">Second part</p>');
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').setReadOnly(false));

      // holding Shift swaps in "Split <p> in new line", which starts the second element on a new line
      const lineItem = page.getByTestId('split-element-newline-menu-item');
      await rightClickAt(page, 'part</p>');
      await expect(item).toBeVisible();
      await expect(lineItem).toBeHidden();
      await page.keyboard.down('Shift');
      await expect(item).toBeHidden();
      await expect(lineItem).toBeVisible();
      await expect(lineItem).toContainText('Split <p> in new line');
      await page.keyboard.up('Shift');
      await expect(lineItem).toBeHidden();
      await page.keyboard.down('Shift');
      await lineItem.click();
      await page.keyboard.up('Shift');
      text = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).toContain('<p n="1">part </p><p n="1">Second </p>\n      <p n="1">part</p>');
    } finally {
      if (stableId) {
        await page.evaluate(async (id) => {
          await (/** @type {any} */ (window)).client.apiClient.filesDelete({ files: [id] });
        }, stableId).catch(() => {});
      }
      await releaseAllLocks(page).catch(() => {});
      await performLogout(page).catch(() => {});
      stopErrorMonitoring();
    }
  });
});

/**
 * Unit comments end-to-end tests
 *
 * As an annotator, comments on a <bibl> from the context menu, checks the stand-off storage, the
 * gutter bubble, the status bar counter and the diagnostic, follows the element when a unit is
 * inserted before it, replies to and resolves the thread in its popover, undoes the resolve, and
 * leaves the comments out of a new version with the "Keep comments" option.
 *
 * @testCovers app/src/plugins/unit-comments.js
 * @testCovers app/src/modules/unit-comments.js
 * @testCovers app/src/modules/node-anchor.js
 * @testCovers app/src/modules/standoff-list.js
 * @testCovers app/src/modules/unit-comment-popover.js
 * @testCovers app/src/modules/codemirror/unit-comment-gutter.js
 * @testCovers app/src/plugins/document-actions.js
 * @testCovers app/src/templates/save-document-dialog.html
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
async function loadCommentDocument(page) {
  const stableId = await page.evaluate(async ({ text }) => {
    const w = /** @type {any} */ (window);
    const xml = w.app.getDependency('xmleditor').getXML()
      .replace(/<standOff[\s\S]*?<\/standOff>\s*/, '')
      .replace(/<text[\s>][\s\S]*<\/text>/, text)
      // a long document: the commented element lies outside the editor's rendered lines when it scrolls to the top
      .replace('</teiHeader>', '</teiHeader>' + '\n'.repeat(300));
    const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'unit-comment-probe', new_version: true });
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
 * @param {Page} page
 * @returns {Promise<string>}
 */
async function editorText(page) {
  return page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
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
 * @param {Page} page
 * @returns {Promise<Array<{id: string, status: string, path: string|null, line: number|null, text: string, replies: number}>>}
 */
async function threads(page) {
  return page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-comments').getThreads());
}

test.describe('Unit comments', () => {

  test('annotators comment on elements, reply and resolve', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadCommentDocument(page);

      // "Comment…" in the context menu comments on the right-clicked element
      const beta = await pointOf(page, 'Beta');
      await page.mouse.click(beta.x, beta.y, { button: 'right' });
      const menuItem = page.getByTestId('unit-comment-menu-item');
      await expect(menuItem).toBeVisible();
      await menuItem.click();
      const prompt = page.getByTestId('unit-comment-prompt');
      await expect(prompt).toBeVisible();
      await prompt.locator('input').fill('check the year');
      await prompt.locator('input').press('Enter');
      await waitForTestMessage(consoleLogs, 'UNIT_COMMENT_ADDED');

      let text = await editorText(page);
      expect(text).toMatch(/<standOff>\s*<listAnnotation type="unit-comment" subtype="fp-sha256-8-v1">/);
      expect(text).toMatch(/<annotation xml:id="uc-[0-9a-z]{6}" motivation="commenting" target="#xpath\(\/TEI\/text\/listBibl\/bibl\[2\]\)" resp="#testannotator">/);
      expect(text).toMatch(/<note type="fingerprint">[0-9a-f]{8}<\/note>/);
      expect(text).toContain('<note type="comment">check the year</note>');
      expect(text).toMatch(/<respStmt>\s*<persName xml:id="testannotator">/);
      await expect(page.locator('#codemirror-container .cm-content')).not.toContainText('check the year');
      await expect(page.getByTestId('unit-comment-meter')).toHaveText('💬 1 open comment');
      await expect(page.locator('.cm-uc-open')).toHaveCount(1);

      // clicking the meter moves the cursor to the element with the open comment
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().dispatch({ selection: { anchor: 0 } }));
      await page.getByTestId('unit-comment-meter').click();
      await expect.poll(async () => page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        return view.state.doc.toString().indexOf('<bibl>Beta') + 1 === view.state.selection.main.head;
      })).toBe(true);
      await expect.poll(async () => page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        const view = app.getDependency('xmleditor').getView();
        return app.getDependency('lint-utils').collectDiagnostics(view.state)
          .filter((/** @type {any} */ d) => d.source === 'unit-comment').map((/** @type {any} */ d) => d.message);
      })).toEqual([expect.stringContaining('check the year')]);

      // the comment follows its element when a unit is inserted before it
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const pos = view.state.doc.toString().indexOf('<bibl>Alpha');
        view.dispatch({ changes: { from: pos, insert: '<bibl>New 2000</bibl>\n      ' } });
      });
      await expect.poll(async () => editorText(page)).toContain('#xpath(/TEI/text/listBibl/bibl[3])');
      let [thread] = await threads(page);
      expect(thread?.path).toBe('/TEI/text/listBibl/bibl[3]');

      // the bubble opens the thread: reply, then resolve
      const bubble = page.locator('.cm-uc-open');
      await bubble.click();
      const popover = page.getByTestId('unit-comment-popover');
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('check the year');
      await popover.getByTestId('unit-comment-reply').fill('fixed');
      await popover.getByTestId('unit-comment-reply-save').click();
      await expect.poll(async () => (await threads(page))[0]?.replies).toBe(1);
      expect(await editorText(page)).toMatch(/motivation="replying" target="#uc-[0-9a-z]{6}" resp="#testannotator"/);

      await page.locator('.cm-uc-open').click();
      await expect(popover.getByTestId('unit-comment-item')).toHaveCount(2);
      await popover.getByTestId('unit-comment-status').click();
      await expect.poll(async () => (await threads(page))[0]?.status).toBe('resolved');
      await expect(page.locator('.cm-uc-resolved')).toHaveCount(1);
      await expect(page.getByTestId('unit-comment-meter')).toBeHidden();
      expect(await editorText(page)).toMatch(/<change when="[^"]+" who="#testannotator" status="resolved"\/>/);

      // annotators can undo comment changes although they cannot edit the standOff by hand
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().focus());
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await threads(page))[0]?.status).toBe('open');

      // the shortcut opens the prompt for the element at the cursor; Escape adds nothing
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Gamma') } });
        view.focus();
      });
      await page.keyboard.press('ControlOrMeta+Shift+M');
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText('<bibl>');
      await page.keyboard.press('Escape');
      await expect(prompt).toHaveCount(0);
      expect((await threads(page)).length).toBe(1);

      // "Keep comments" unchecked: the new version starts without comments
      const dialog = page.locator('sl-dialog[name="saveDocumentDialog"]');
      await page.locator('sl-button[name="saveRevision"]').click();
      await expect(dialog).toHaveAttribute('open', '');
      const keepSection = dialog.locator('[name="keepCommentsSection"]');
      const saveToNewCopy = dialog.locator('sl-checkbox[name="saveToNewCopy"]');
      if (!(await saveToNewCopy.evaluate((/** @type {any} */ el) => el.checked))) await saveToNewCopy.click();
      await expect(keepSection).toBeVisible();
      await keepSection.locator('sl-checkbox[name="keepComments"]').click();
      await dialog.locator('sl-input[name="changeDesc"] input').fill('Copy without comments');
      await dialog.locator('sl-button[name="submit"]').click();
      await waitForTestMessage(consoleLogs, 'UNIT_COMMENTS_CLEARED');
      await waitForTestMessage(consoleLogs, 'NEW_VERSION_LOADED');
      await expect.poll(async () => editorText(page)).not.toContain('unit-comment');
      await expect(page.getByTestId('unit-comment-meter')).toBeHidden();
      await expect(page.locator('.cm-unit-comment-gutter')).toHaveCount(0);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

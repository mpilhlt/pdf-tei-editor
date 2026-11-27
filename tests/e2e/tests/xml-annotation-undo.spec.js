/**
 * E2E test: undo and redo, and whitespace editing, in the visual annotation mode (#824).
 *
 * The visual mode makes CodeMirror's editing commands read-only, which must not stop undo and
 * redo of the annotations made in it, neither from the toolbar buttons nor from the keyboard.
 *
 * @testCovers app/src/plugins/xml-annotation.js
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/modules/codemirror/command-read-only.js
 * @testCovers app/src/modules/codemirror/whitespace-keys.js
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

const PLAIN = '<p>Alpha Beta Gamma</p>';
const ANNOTATED = '<p>Alpha <bibl>Beta</bibl> Gamma</p>';

/**
 * @param {Page} page
 * @returns {Promise<string>}
 */
async function editorText(page) {
  return page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
}

test.describe('Visual annotation mode', () => {
  test('undoes and redoes annotations with the buttons and the keyboard', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    // visual mode needs annotation tags for the variant: no extractor of the test setup has any
    await page.route('**/api/v1/extract/list', async route => {
      const response = await route.fetch();
      const extractors = await response.json();
      if (!Array.isArray(extractors) || !extractors.length) return route.fulfill({ response });
      const variant = 'grobid.training.segmentation';
      extractors[0].variants = [...(extractors[0].variants ?? []), variant];
      extractors[0].annotationTags = { ...extractors[0].annotationTags, [variant]: [{ tag: 'bibl', label: 'Bibl', color: '#cc6600' }] };
      await route.fulfill({ response, json: extractors });
    });

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const stableId = await page.evaluate(async (plain) => {
        const w = /** @type {any} */ (window);
        const xml = w.app.getDependency('xmleditor').getXML().replace(/<text[\s>][\s\S]*<\/text>/, `<text><body>${plain}</body></text>`);
        const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'xml-annotation-undo', new_version: true });
        await w.app.getDependency('services').load({ xml: res.file_id });
        return res.file_id;
      }, PLAIN);
      await page.waitForFunction((id) => {
        const app = /** @type {any} */ (window).app;
        return app.getCurrentState().xml === id && app.getCurrentState().editorReadOnly === false;
      }, stableId, { timeout: 20000 });

      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation').dispatchStateChange({ view: 'annotation' }));
      await page.waitForFunction(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').isReadOnly());

      // an annotation, dispatched like the annotation popup does
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const pos = view.state.doc.toString().indexOf('Beta');
        view.dispatch({ changes: { from: pos, to: pos + 4, insert: '<bibl>Beta</bibl>' }, userEvent: 'input.annotate' });
      });
      expect(await editorText(page)).toContain(ANNOTATED);

      const undoBtn = page.locator('[name="undoBtn"]');
      const redoBtn = page.locator('[name="redoBtn"]');
      await expect(undoBtn).toBeEnabled();
      await undoBtn.click();
      await expect.poll(() => editorText(page)).toContain(PLAIN);
      await expect(redoBtn).toBeEnabled();
      await redoBtn.click();
      await expect.poll(() => editorText(page)).toContain(ANNOTATED);

      // the keyboard: a click puts the keyboard focus into the editor
      const alpha = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Alpha') + 2);
        return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(alpha.x, alpha.y);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => editorText(page)).toContain(PLAIN);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => editorText(page)).toContain(ANNOTATED);

      // the other editing commands stay read-only
      // Backspace after "Al" would delete text, not whitespace
      for (const key of ['Backspace', 'Delete', 'a']) await page.keyboard.press(key);
      expect(await editorText(page)).toContain(ANNOTATED);

      // except for whitespace: Enter breaks the line keeping its indentation, Tab/Shift-Tab indent and outdent
      await page.mouse.click(alpha.x, alpha.y);
      const before = await editorText(page);
      const cursor = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.selection.main.head);
      const lineStart = before.lastIndexOf('\n', cursor - 1) + 1;
      const indent = /^[ \t]*/.exec(before.slice(lineStart))?.[0] ?? '';
      await page.keyboard.press('Enter');
      await expect.poll(() => editorText(page)).toBe(before.slice(0, cursor) + '\n' + indent + before.slice(cursor));
      const afterEnter = await editorText(page);
      await page.keyboard.press('Tab');
      await expect.poll(() => editorText(page)).not.toBe(afterEnter);
      await page.keyboard.press('Shift+Tab');
      await expect.poll(() => editorText(page)).toBe(afterEnter);
      // Backspace at the start of the new line's text deletes the copied indentation and the line break
      for (let i = 0; i <= indent.length; i++) await page.keyboard.press('Backspace');
      await expect.poll(() => editorText(page)).toBe(before);
      // and then stops at text
      await page.keyboard.press('Backspace');
      expect(await editorText(page)).toBe(before);
      await page.keyboard.press('Enter');
      await expect.poll(() => editorText(page)).toBe(afterEnter);
      // undo history may group the whitespace edits: undo until nothing is left of them
      for (let i = 0; i < 10 && await editorText(page) !== before; i++) await page.keyboard.press('ControlOrMeta+z');
      expect(await editorText(page)).toBe(before);
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation')?.dispatchStateChange({ view: null })).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

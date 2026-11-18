/**
 * E2E test: clicking a badge in the visual annotation mode (#834).
 *
 * A click on the badge of an element that is not the selected one opens its popup without
 * selecting the element: the cursor, the `xpath` state and the scroll position stay as they are.
 *
 * @testCovers app/src/modules/codemirror/xml-annotation-decorations.js
 * @testCovers app/src/plugins/xml-annotation.js
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

const BODY = '<p>Alpha <bibl>Beta</bibl> Gamma</p><p>Delta <bibl>Epsilon</bibl> Zeta</p>';

test.describe('Visual annotation mode', () => {
  test('opens the popup of a badge without selecting its element', async ({ page }) => {
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
      const stableId = await page.evaluate(async (body) => {
        const w = /** @type {any} */ (window);
        const xml = w.app.getDependency('xmleditor').getXML().replace(/<text[\s>][\s\S]*<\/text>/, `<text><body>${body}</body></text>`);
        const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'xml-annotation-badge-click', new_version: true });
        await w.app.getDependency('services').load({ xml: res.file_id });
        return res.file_id;
      }, BODY);
      await page.waitForFunction((id) => {
        const app = /** @type {any} */ (window).app;
        return app.getCurrentState().xml === id && app.getCurrentState().editorReadOnly === false;
      }, stableId, { timeout: 20000 });

      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation').dispatchStateChange({ view: 'annotation' }));
      await page.waitForFunction(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').isReadOnly());
      const badges = page.locator('.cm-content .ann-badge[data-tag="bibl"]');
      await expect(badges).toHaveCount(2);

      // put the cursor into the first <bibl> by clicking its text
      const beta = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Beta') + 2);
        return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(beta.x, beta.y);

      /** @returns {Promise<{xpath: string|null, head: number, scrollTop: number}>} */
      const editorState = () => page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const view = w.app.getDependency('xmleditor').getView();
        return { xpath: w.app.getCurrentState().xpath, head: view.state.selection.main.head, scrollTop: view.scrollDOM.scrollTop };
      });
      const before = await editorState();

      // a click on the badge of the second <bibl> opens its popup
      await badges.nth(1).click();
      const popup = page.locator('.ann-popup');
      await expect(popup).toBeVisible();
      await expect(popup).toContainText('bibl');

      // and leaves the selection where it was
      await page.waitForTimeout(500);
      expect(await editorState()).toEqual(before);
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation')?.dispatchStateChange({ view: null })).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

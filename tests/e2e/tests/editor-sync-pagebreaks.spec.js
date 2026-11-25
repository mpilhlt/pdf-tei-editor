/**
 * "Sync with editor" end-to-end tests for documents with page breaks
 *
 * Uses the page break fixtures (tests/e2e/fixtures/make-pagebreak-fixtures.js):
 * - `pagebreaks-n`: a cover page without `<pb/>`, then `<pb n="2"/>` .. `<pb n="4"/>`
 *   (the `n` attribute gives the PDF page, the position among the `<pb/>` does not)
 * - `pagebreaks-ordinal`: `<pb/>` without `n` on every page (the position gives the page)
 *
 * Checks both directions: paging through the PDF scrolls the XML editor to the
 * `<pb/>` of the page without changing the selection, and looking up a node in
 * the PDF finds the page of its `<pb/>` (without that programmatic navigation
 * scrolling the editor back).
 *
 * @testCovers app/src/plugins/editor-sync.js
 * @testCovers app/src/plugins/pdfviewer.js
 * @testCovers app/src/modules/pdfviewer.js
 * @testCovers app/src/modules/tei-utils.js
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

/**
 * Loads the PDF and the TEI document of a page break fixture and waits until both are shown.
 * @param {Page} page
 * @param {string} docId - File name stem of the fixture
 * @param {number} pageCount - Number of pages of the fixture PDF
 */
async function loadFixture(page, docId, pageCount) {
  const ids = await page.evaluate(async (id) => {
    const result = await /** @type {any} */ (window).client.apiClient.filesList();
    const group = result.files.find((/** @type {any} */ f) => f.doc_id === id);
    return group ? { pdf: group.source?.id, xml: group.artifacts?.[0]?.id } : null;
  }, docId);
  expect(ids?.pdf, `PDF of fixture "${docId}" not found`).toBeTruthy();
  expect(ids?.xml, `TEI of fixture "${docId}" not found`).toBeTruthy();

  await page.evaluate((ids) => /** @type {any} */ (window).app.getDependency('services').load(ids), ids);
  await page.waitForFunction((pageCount) => {
    const app = /** @type {any} */ (window).app;
    const tree = app.getDependency('xmleditor').getXmlTree();
    return app.getDependency('pdfviewer').pdfDoc?.numPages === pageCount &&
      tree?.getElementsByTagNameNS('*', 'pb').length > 0;
  }, pageCount, { timeout: 15000 });
  // Start on the first page; this is a programmatic navigation and must not sync
  await page.evaluate(() => /** @type {any} */ (window).app.getDependency('pdfviewer').goToPage(1));
}

/**
 * Records the `<pb/>` elements (by their 1-based position) that the XML editor is scrolled to.
 * @param {Page} page
 */
async function recordEditorScrolls(page) {
  await page.evaluate(() => {
    const win = /** @type {any} */ (window);
    const xmlEditor = win.app.getDependency('xmleditor');
    const scrollToNode = xmlEditor.scrollToNode;
    win.__editorScrolls = [];
    xmlEditor.scrollToNode = (/** @type {Element} */ node) => {
      const pbs = Array.from(node.ownerDocument.getElementsByTagNameNS('*', 'pb'));
      win.__editorScrolls.push(pbs.indexOf(node) + 1);
      return scrollToNode(node);
    };
  });
}

/**
 * @param {Page} page
 * @returns {Promise<number[]>} The positions of the `<pb/>` elements scrolled to so far
 */
async function editorScrolls(page) {
  return page.evaluate(() => /** @type {any} */ (window).__editorScrolls);
}

/**
 * Turns the "Sync with editor" switch on by clicking it.
 * @param {Page} page
 */
async function enableSync(page) {
  await page.locator('#pdf-viewer [name="syncSwitch"] sl-switch').click();
  await expect.poll(() => page.evaluate(() =>
    /** @type {any} */ (window).app.getDependency('editor-sync').isEnabled())).toBe(true);
}

/**
 * @param {Page} page
 * @returns {Promise<number>} The cursor position in the XML editor
 */
async function cursorPosition(page) {
  return page.evaluate(() =>
    /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.selection.main.head);
}

const CASES = [
  {
    docId: 'pagebreaks-n',
    pageCount: 4,
    // page 2 starts with <pb n="2"/>, the first <pb/>
    nextPagePb: 1,
    // the first <p> after <pb n="3"/> (the second <pb/>) is on page 3
    lookupPb: 2,
    lookupPage: 3
  },
  {
    docId: 'pagebreaks-ordinal',
    pageCount: 3,
    // page 2 starts with the second <pb/>
    nextPagePb: 2,
    // the first <p> after the third <pb/> is on page 3
    lookupPb: 3,
    lookupPage: 3
  }
];

test.describe('Sync with editor in documents with page breaks', () => {
  for (const c of CASES) {
    test(`syncs PDF pages and <pb/> elements in both directions (${c.docId})`, async ({ page }) => {
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

      try {
        await navigateAndLogin(page, 'testannotator', 'annotatorpass');
        await loadFixture(page, c.docId, c.pageCount);
        await recordEditorScrolls(page);
        await enableSync(page);

        // PDF -> XML: the page button is a user navigation
        const cursorBefore = await cursorPosition(page);
        await page.locator('#pdf-viewer [name="nextPageBtn"]').click();
        await expect.poll(() => editorScrolls(page)).toEqual([c.nextPagePb]);
        // only scrolled: the selection is unchanged
        expect(await cursorPosition(page)).toBe(cursorBefore);

        // XML -> PDF: look up the first <p> after a <pb/>
        await page.evaluate(async (pbIndex) => {
          const app = /** @type {any} */ (window).app;
          const tree = app.getDependency('xmleditor').getXmlTree();
          const pb = tree.getElementsByTagNameNS('*', 'pb')[pbIndex - 1];
          let p = pb.nextElementSibling;
          while (p && p.localName !== 'p') p = p.nextElementSibling;
          await app.getDependency('services').searchNodeContentsInPdf(p);
        }, c.lookupPb);
        const matchPage = await page.evaluate(() =>
          /** @type {any} */ (window).app.getDependency('pdfviewer')._highlightMatch?.page);
        expect(matchPage).toBe(c.lookupPage);

        // The search scrolled the PDF: that must not scroll the editor
        await page.waitForTimeout(1000);
        expect(await editorScrolls(page)).toEqual([c.nextPagePb]);

        // Turning the switch off removes the highlight (#903)
        await expect.poll(() => page.locator('#pdf-viewer .cluster-highlight, #pdf-viewer .span-highlight').count())
          .toBeGreaterThan(0);
        await page.locator('#pdf-viewer [name="syncSwitch"] sl-switch').click();
        await expect.poll(() => page.locator('#pdf-viewer .cluster-highlight, #pdf-viewer .span-highlight').count())
          .toBe(0);
        expect(await page.evaluate(() =>
          /** @type {any} */ (window).app.getDependency('pdfviewer')._highlightMatch)).toBeNull();
      } finally {
        stopErrorMonitoring();
        await releaseAllLocks(page);
        await performLogout(page);
      }
    });
  }
});

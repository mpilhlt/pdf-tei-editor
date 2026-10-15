/**
 * PDF viewer search scrolling end-to-end tests
 *
 * Checks that scrolling to a PDF text match starts from the current scroll
 * position (instead of jumping to the top of the target page first) and that
 * the match ends up inside the visible area.
 *
 * @testCovers app/src/modules/pdfviewer.js
 */

/**
 * @import { PDFJSViewer } from '../../../app/src/modules/pdfviewer.js'
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

/**
 * Picks a query from the bottom of a later page of the loaded PDF.
 * @param {Page} page
 * @returns {Promise<{query: string, pageNumber: number}>}
 */
async function pickBottomOfPageQuery(page) {
  return page.evaluate(async () => {
    /** @type {PDFJSViewer} */
    const viewer = /** @type {any} */ (window).app.getDependency('pdfviewer');
    const models = await viewer._getPageModels();
    // Use the last page with enough text, preferring one that is not the first page
    const model = [...models].reverse().find(m => m.page > 1 && m.text.length > 400) ?? models[0];
    // Items with the lowest baseline are at the bottom of the page (footnotes)
    const items = model.items
      .filter(it => it.str.trim().length > 20)
      .sort((a, b) => a.transform[5] - b.transform[5]);
    // Skip the lowest few items (page footer) and take a long line above them
    const item = items[Math.min(3, items.length - 1)];
    return { query: item.str.trim(), pageNumber: model.page };
  });
}

/**
 * Runs a search and records the container's scrollTop on every animation
 * frame until scrolling has settled.
 * @param {Page} page
 * @param {string} query
 * @param {number|null} [interruptAt] - If given, jump to this scroll position
 *   right after the search to simulate an interrupted scroll
 * @returns {Promise<{samples: number[], start: number, matchPage: number|null, visible: boolean, boxTop: number, boxBottom: number, viewTop: number, viewBottom: number}>}
 */
async function searchAndTrackScroll(page, query, interruptAt = null) {
  return page.evaluate(async ({ query, interruptAt }) => {
    /** @type {PDFJSViewer} */
    const viewer = /** @type {any} */ (window).app.getDependency('pdfviewer');
    const container = viewer.pdfViewerContainer;
    const start = container.scrollTop;
    const samples = [start];
    let running = true;
    const sample = () => {
      samples.push(container.scrollTop);
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const match = await viewer.search(query);
    if (interruptAt !== null) {
      // Cut the smooth scroll short, as happens when the page geometry changes
      // during the scroll
      await new Promise(r => setTimeout(r, 50));
      container.scrollTo({ top: interruptAt, behavior: 'instant' });
    }
    // Wait until the scroll position has been stable for a while, twice, so
    // that a correction after the first scroll has settled is included
    for (let round = 0; round < 2; round++) {
      let last = -1, stableFrames = 0;
      for (let i = 0; i < 300 && stableFrames < 20; i++) {
        await new Promise(r => requestAnimationFrame(r));
        stableFrames = container.scrollTop === last ? stableFrames + 1 : 0;
        last = container.scrollTop;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    running = false;
    // Wait for the highlight (drawn once the text layer is rendered)
    let box = null;
    for (let i = 0; i < 100 && !box; i++) {
      box = viewer.viewer.querySelector('.cluster-highlight');
      if (!box) await new Promise(r => setTimeout(r, 50));
    }
    const viewRect = container.getBoundingClientRect();
    const boxRect = box ? box.getBoundingClientRect() : null;
    return {
      samples,
      start,
      matchPage: match ? match.page : null,
      visible: !!boxRect && boxRect.top >= viewRect.top && boxRect.bottom <= viewRect.bottom,
      boxTop: boxRect ? boxRect.top : NaN,
      boxBottom: boxRect ? boxRect.bottom : NaN,
      viewTop: viewRect.top,
      viewBottom: viewRect.bottom
    };
  }, { query, interruptAt });
}

test.describe('PDF viewer search scrolling', () => {

  test('scrolls from the current position and shows the match', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const loadedAt = Date.now();

      const { query, pageNumber } = await pickBottomOfPageQuery(page);

      // 1. From the top of the document: the match near the bottom of a later
      //    page must end up inside the visible area
      await page.evaluate(() => {
        /** @type {PDFJSViewer} */
        const viewer = /** @type {any} */ (window).app.getDependency('pdfviewer');
        viewer.pdfViewerContainer.scrollTop = 0;
      });
      const far = await searchAndTrackScroll(page, query);
      expect(far.matchPage).toBe(pageNumber);
      expect(far.visible, JSON.stringify({ ...far, samples: undefined })).toBe(true);

      // The viewer's restore of the saved scroll position must not move the
      // view away from the match later on (it used to run on a 5s timeout
      // after loading). Make the saved position differ from the current one.
      await page.evaluate(() => {
        /** @type {any} */
        const app = /** @type {any} */ (window).app;
        const key = 'plugin.pdfviewer.state';
        const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
        const pdfId = app.getCurrentState().pdf;
        saved[pdfId] = { ...saved[pdfId], page: 1, scrollX: 0, scrollY: 0 };
        sessionStorage.setItem(key, JSON.stringify(saved));
      });
      await page.waitForTimeout(Math.max(0, 6500 - (Date.now() - loadedAt)));
      const stillVisible = await page.evaluate(() => {
        /** @type {PDFJSViewer} */
        const viewer = /** @type {any} */ (window).app.getDependency('pdfviewer');
        const box = viewer.viewer.querySelector('.cluster-highlight');
        const viewRect = viewer.pdfViewerContainer.getBoundingClientRect();
        const boxRect = box?.getBoundingClientRect();
        return !!boxRect && boxRect.top >= viewRect.top && boxRect.bottom <= viewRect.bottom;
      });
      expect(stillVisible).toBe(true);

      // 2. From a position inside the target page, with the match below the
      //    visible area: scrolling must start from the current position and
      //    move towards the match, never jumping back to the top of the page
      await page.evaluate((pageNumber) => {
        /** @type {PDFJSViewer} */
        const viewer = /** @type {any} */ (window).app.getDependency('pdfviewer');
        const container = viewer.pdfViewerContainer;
        viewer._clearClusterHighlights(true);
        const pageDiv = viewer.pdfViewer.getPageView(pageNumber - 1).div;
        const pageTop = pageDiv.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        container.scrollTop = pageTop + 50;
      }, pageNumber);
      await page.waitForTimeout(300);
      const near = await searchAndTrackScroll(page, query);
      const samples = `scroll samples: ${near.samples.join(',')}`;
      expect(near.visible, samples).toBe(true);
      expect(near.samples[near.samples.length - 1], samples).toBeGreaterThan(near.start);
      for (let i = 1; i < near.samples.length; i++) {
        expect(near.samples[i], samples).toBeGreaterThanOrEqual(near.samples[i - 1] - 1);
      }

      // 3. When the scroll is cut short, the position is corrected once it
      //    has settled, so that the match still ends up visible
      await page.evaluate(() => {
        /** @type {PDFJSViewer} */
        const viewer = /** @type {any} */ (window).app.getDependency('pdfviewer');
        viewer._clearClusterHighlights(true);
        viewer.pdfViewerContainer.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      const interrupted = await searchAndTrackScroll(page, query, 0);
      expect(interrupted.visible, JSON.stringify({ ...interrupted, samples: undefined })).toBe(true);
    } finally {
      stopErrorMonitoring();
    }
  });
});

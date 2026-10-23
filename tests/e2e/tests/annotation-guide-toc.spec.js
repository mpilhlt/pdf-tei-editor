/**
 * Annotation guide table of contents end-to-end tests
 *
 * Serves a Markdown annotation guide for every variant (by adding it to the
 * extractor list) and checks that the drawer footer's "Contents" drop-up
 * lists the guide's headings indented by level, opens above its trigger,
 * shows the whole TOC unless it is taller than the guide container, and
 * scrolls to a heading when its entry is clicked.
 *
 * @testCovers app/src/plugins/annotation-guide.js
 * @testCovers app/src/templates/annotation-guide-drawer.html
 * @testCovers app/src/modules/markdown-utils.js
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST'
];

const GUIDE_PATH = '/e2e/annotation-guide-toc.md';

const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of filler text.`).join('\n\n');

const SHORT_GUIDE = `# Guide

${filler}

## Data correction

${filler}

### Names

${filler}

## Formatting

${filler}
`;

const LONG_GUIDE = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nText ${i + 1}.\n`).join('\n');

/**
 * Serves `getGuide()` at GUIDE_PATH and adds a Markdown guide for every
 * variant ("*") pointing there in front of the first extractor's guides.
 * Must be called before the app loads the extractor list.
 * @param {Page} page
 * @param {() => string} getGuide
 * @returns {Promise<void>}
 */
async function serveGuide(page, getGuide) {
  await page.route(`**${GUIDE_PATH}`, route => route.fulfill({
    status: 200,
    contentType: 'text/markdown',
    headers: { 'Cache-Control': 'no-store' },
    body: getGuide()
  }));
  await page.route('**/api/v1/extract/list*', async route => {
    const response = await route.fetch();
    const extractors = await response.json();
    const guide = { variant_ids: ['*'], type: 'markdown', url: GUIDE_PATH };
    if (extractors.length > 0) {
      extractors[0].annotationGuides = [guide, ...(extractors[0].annotationGuides || [])];
    }
    await route.fulfill({ response, json: extractors });
  });
}

/**
 * Opens the annotation guide drawer and loads the "*" guide.
 * @param {Page} page
 * @returns {Promise<void>}
 */
async function openGuide(page) {
  await page.evaluate(async () => {
    const guide = /** @type {any} */ (window).appAnnotationGuide;
    await guide.open();
    await guide.load('e2e-toc-variant');
  });
}

/**
 * Reads the TOC entries and the geometry of the drop-up.
 * @param {Page} page
 */
async function tocState(page) {
  return await page.evaluate(() => {
    const drawer = /** @type {any} */ (window).ui.annotationGuideDrawer;
    const menu = drawer.tocDropdown.tocMenu;
    const body = drawer.shadowRoot.querySelector('[part="body"]');
    const items = Array.from(menu.querySelectorAll('sl-menu-item'));
    const menuRect = menu.getBoundingClientRect();
    const buttonRect = drawer.tocDropdown.tocBtn.getBoundingClientRect();
    return {
      hidden: drawer.tocDropdown.hidden,
      labels: items.map(item => item.textContent.trim()),
      indents: items.map(item => item.querySelector('span').style.paddingLeft),
      menuAboveButton: menuRect.bottom <= buttonRect.top + 1,
      menuHeight: menu.clientHeight,
      menuScrollHeight: menu.scrollHeight,
      bodyHeight: body.clientHeight,
      bodyScrollTop: body.scrollTop
    };
  });
}

test.describe('Annotation guide TOC', () => {

  test('lists headings, drops up, fits the container and navigates', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    let guideMarkdown = SHORT_GUIDE;

    try {
      await serveGuide(page, () => guideMarkdown);
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      await openGuide(page);

      const drawer = page.locator('sl-drawer[name="annotationGuideDrawer"]');
      await expect(drawer.locator('#data-correction')).toBeAttached();

      let state = await tocState(page);
      expect(state.hidden).toBe(false);
      expect(state.labels).toEqual(['Guide', 'Data correction', 'Names', 'Formatting']);
      expect(state.indents).toEqual(['0rem', '1.25rem', '2.5rem', '1.25rem']);

      // the TOC opens upwards and shows all entries without scrolling
      await drawer.locator('sl-button[name="tocBtn"]').click();
      await expect(drawer.locator('sl-menu[name="tocMenu"]')).toBeVisible();
      state = await tocState(page);
      expect(state.menuAboveButton).toBe(true);
      expect(state.menuScrollHeight).toBeLessThanOrEqual(state.menuHeight);

      // clicking an entry scrolls the guide to its heading
      await drawer.locator('sl-menu-item', { hasText: 'Formatting' }).click();
      await expect.poll(async () => (await tocState(page)).bodyScrollTop).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => {
        const drawer = /** @type {any} */ (window).ui.annotationGuideDrawer;
        const body = drawer.shadowRoot.querySelector('[part="body"]');
        const heading = drawer.querySelector('#formatting');
        return Math.abs(heading.getBoundingClientRect().top - body.getBoundingClientRect().top) < 40;
      })).toBe(true);

      // a TOC taller than the guide container is limited to its height and scrolls
      guideMarkdown = LONG_GUIDE;
      await openGuide(page);
      await expect(drawer.locator('#section-120')).toBeAttached();
      await drawer.locator('sl-button[name="tocBtn"]').click();
      await expect(drawer.locator('sl-menu[name="tocMenu"]')).toBeVisible();
      state = await tocState(page);
      expect(state.labels).toHaveLength(120);
      expect(state.menuHeight).toBeLessThanOrEqual(state.bodyHeight);
      expect(state.menuScrollHeight).toBeGreaterThan(state.menuHeight);
      expect(state.menuAboveButton).toBe(true);
      await page.keyboard.press('Escape');

      // without headings the trigger is hidden
      guideMarkdown = 'Only text.\n';
      await openGuide(page);
      await expect(drawer.locator('.markdown-body p', { hasText: 'Only text.' })).toBeAttached();
      expect((await tocState(page)).hidden).toBe(true);

      await page.evaluate(() => /** @type {any} */ (window).appAnnotationGuide.close());
    } finally {
      stopErrorMonitoring();
      await performLogout(page);
    }
  });
});

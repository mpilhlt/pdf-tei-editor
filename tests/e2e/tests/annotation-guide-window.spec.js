/**
 * Annotation guide search and window end-to-end tests
 *
 * Serves a Markdown guide at a GitHub blob URL for every variant, searches it in the drawer (search button in the
 * header, Ctrl+K), opens the section in the standalone guide window, and uses the window without a login: deep
 * link to a heading at a commit, search, the list of guides, an unknown guide and sanitized HTML.
 *
 * @testCovers app/src/plugins/annotation-guide.js
 * @testCovers app/src/templates/annotation-guide-drawer.html
 * @testCovers app/src/guide.js
 * @testCovers app/web/guide.html
 * @testCovers app/src/modules/guide-viewer.js
 * @testCovers app/src/modules/guide-links.js
 * @testCovers app/src/modules/markdown-page-viewer.js
 * @testCovers app/src/modules/manual-search-box.js
 * @testCovers fastapi_app/main.py
 * @testCovers fastapi_app/routers/annotation_guides.py
 */

/**
 * @import { BrowserContext } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load resource.*404',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST'
];

const SHA = '0123456789abcdef0123456789abcdef01234567';
const BLOB_URL = 'https://github.com/e2e-org/e2e-guides/blob/main/guide.md';

const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of filler text.`).join('\n\n');

/**
 * @param {string} version
 * @returns {string}
 */
function guide(version) {
  return `# E2E Guide

Version ${version}. Footnote<sup>1</sup> <img src="x.png" onerror="window.guideXss = true">

${filler}

## Data correction

${filler}

### Personal names

Write the surname of a person in the zebra element.

${filler}

## Formatting

${filler}
`;
}

/**
 * Serves the guide (at the branch and at SHA), adds it for every variant to the extractor list and lists it as the
 * only guide of the guide window. Routes on the context, so the guide window gets them as well.
 * @param {BrowserContext} context
 */
async function serveGuide(context) {
  await context.route('https://raw.githubusercontent.com/e2e-org/e2e-guides/**', route => {
    const atCommit = route.request().url().includes(`/${SHA}/`);
    return route.fulfill({ status: 200, contentType: 'text/plain', body: guide(atCommit ? 'at commit' : 'on main') });
  });
  await context.route('**/api/v1/extract/list*', async route => {
    const response = await route.fetch();
    const extractors = await response.json();
    const entry = { variant_ids: ['*'], type: 'markdown', category: 'primary', url: `${BLOB_URL}#data-correction` };
    if (extractors.length > 0) {
      extractors[0].annotationGuides = [entry, ...(extractors[0].annotationGuides || [])];
    }
    await route.fulfill({ response, json: extractors });
  });
  await context.route('**/api/v1/annotation-guides', route => route.fulfill({
    json: {
      guides: [{
        id: 'e2e-guides-guide',
        url: BLOB_URL,
        url_template: 'https://github.com/e2e-org/e2e-guides/blob/{ref}/guide.md',
        sections: [{ anchor: 'data-correction', label: 'Data correction rules', category: 'primary', variant_ids: ['*'] }]
      }]
    }
  }));
}

test.describe('Annotation guide search and window', () => {

  test('search in the drawer and open the section in the guide window', async ({ page, context }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await serveGuide(context);
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      await page.evaluate(async () => {
        const guide = /** @type {any} */ (window).appAnnotationGuide;
        await guide.open();
        await guide.load('e2e-window-variant');
      });
      const drawer = page.locator('sl-drawer[name="annotationGuideDrawer"]');
      await expect(drawer.locator('#personal-names')).toBeAttached();

      await expect(drawer.locator('sl-badge[name="personalBadge"]')).toBeHidden();

      // raw HTML is sanitized: formatting stays, scripts go
      await expect(drawer.locator('[name="content"] sup')).toHaveText('1');
      expect(await drawer.locator('[name="content"] img[onerror]').count()).toBe(0);
      expect(await page.evaluate(() => /** @type {any} */ (window).guideXss)).toBeUndefined();
      // relative images resolve against the raw URL of the guide
      expect(await drawer.locator('[name="content"] img').getAttribute('src')).toBe('https://raw.githubusercontent.com/e2e-org/e2e-guides/main/x.png');

      // the search button replaces the title with the search field
      const input = drawer.locator('sl-input[name="searchInput"]');
      await expect(input).toBeHidden();
      await drawer.locator('sl-icon-button[data-name="searchBtn"]').click();
      await expect(input).toBeVisible();
      await expect(drawer.locator('[name="titleText"]')).toBeHidden();

      // results are the sections of the guide, without page rows
      await input.locator('input').fill('zebra');
      const results = drawer.locator('[name="searchResults"]');
      await expect(results.locator('.manual-search-section.selected')).toContainText('Personal names');
      expect(await results.locator('.manual-search-page').count()).toBe(0);

      // Enter scrolls to the section, highlights the words and closes the search
      await page.keyboard.press('Enter');
      await expect(input).toBeHidden();
      await expect(drawer.locator('mark.manual-search-mark', { hasText: 'zebra' })).toBeAttached();

      // Ctrl+K opens the search again, Esc closes it without closing the drawer
      await page.keyboard.press('Control+k');
      await expect(input).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(input).toBeHidden();
      await expect(drawer).toHaveAttribute('open', '');

      // "Open in new window" opens the guide window at the section shown
      await expect.poll(() => page.evaluate(() => {
        const drawer = /** @type {any} */ (window).ui.annotationGuideDrawer;
        const body = drawer.shadowRoot.querySelector('[part="body"]');
        const heading = drawer.content.querySelector('#personal-names');
        return Math.abs(heading.getBoundingClientRect().top - body.getBoundingClientRect().top);
      })).toBeLessThan(40);
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        drawer.locator('sl-icon-button[data-name="openWindowBtn"]').click()
      ]);
      await popup.waitForLoadState();
      expect(popup.url()).toMatch(/\/guide\/e2e-guides-guide(\?dev)?#personal-names$/);
      await expect(popup.locator('[data-name="content"] #personal-names')).toBeVisible();
      await popup.close();

      // headings copy the window URL
      await page.evaluate(() => {
        /** @type {any} */ (window).copiedText = null;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (/** @type {string} */ text) => { /** @type {any} */ (window).copiedText = text; } }
        });
      });
      const heading = drawer.locator('#formatting');
      await heading.hover();
      await heading.locator('sl-icon-button.heading-link').click();
      await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).copiedText))
        .toBe(new URL('/guide/e2e-guides-guide#formatting', page.url()).toString());

      await drawer.locator('sl-button[name="closeBtn"]').click();
    } finally {
      stopErrorMonitoring();
      await performLogout(page);
    }
  });

  test('the guide window works without login, with deep links at a commit, search and the guide list', async ({ page, context }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await serveGuide(context);

      // a deep link at a commit shows the section of that version
      await page.goto(`/guide/e2e-guides-guide?ref=${SHA}#formatting`);
      const content = page.locator('[data-name="content"]');
      await expect(content.locator('#formatting')).toBeInViewport();
      await expect(content).toContainText('Version at commit.');
      await expect(page).toHaveTitle(/E2E Guide/);
      await expect(page.locator('[data-name="versionInfo"]')).toHaveText('Version 0123456');
      await expect(page.locator('[data-name="toc"] a', { hasText: 'Personal names' })).toBeVisible();
      expect(await content.locator('img[onerror]').count()).toBe(0);

      // search finds body text and opens the section under its URL
      const input = page.locator('sl-input[data-name="searchInput"]');
      await page.keyboard.press('/');
      await expect(input).toBeFocused();
      await input.locator('input').fill('zebra');
      const results = page.locator('[data-name="searchResults"]');
      await results.locator('.manual-search-section', { hasText: 'Personal names' }).click();
      await expect(content.locator('mark.manual-search-mark', { hasText: 'zebra' })).toBeAttached();
      expect(new URL(page.url()).hash).toBe('#personal-names');
      expect(new URL(page.url()).searchParams.get('ref')).toBe(SHA);

      // without a commit, the configured branch
      await page.goto('/guide/e2e-guides-guide');
      await expect(content).toContainText('Version on main.');

      // the list of guides links to the sections the extractors point to
      await page.goto('/guide/');
      await expect(content.locator('h1')).toHaveText('Annotation Guides');
      await content.locator('a', { hasText: 'Data correction rules' }).click();
      await expect(content.locator('#data-correction')).toBeInViewport();
      expect(new URL(page.url()).pathname).toBe('/guide/e2e-guides-guide');

      // an unknown guide
      await page.goto('/guide/no-such-guide');
      await expect(content.locator('h1')).toHaveText('Guide not found');
    } finally {
      stopErrorMonitoring();
    }
  });
});

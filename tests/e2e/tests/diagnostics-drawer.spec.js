/**
 * Diagnostics drawer end-to-end tests
 *
 * Injects diagnostics into the XML editor and checks that the drawer over the
 * PDF viewer lists them, slides out (leaving a floating button) and back in
 * depending on the focus, selects
 * the text of a clicked diagnostic, and applies or dismisses the checked
 * diagnostics (switching off the merge view). Also checks that the drawer,
 * which stays open permanently, does not hide the help icon.
 *
 * @testCovers app/src/plugins/diagnostics-drawer.js
 * @testCovers app/src/templates/help-widget.html
 * @testCovers app/src/modules/lint-utils.js
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

const SOURCE = 'e2e-test';

/**
 * Loads an editable copy of the gold document loaded by selectFirstDocuments()
 * (gold is read-only for an annotator, and the fixture must not be changed):
 * saves its content as a new version and loads that.
 * @param {Page} page
 * @returns {Promise<void>}
 */
async function loadEditableVersion(page) {
  const stableId = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const res = await w.client.apiClient.filesSave({
      xml_string: w.app.getDependency('xmleditor').getXML(),
      file_id: 'diagnostics-drawer-probe',
      new_version: true
    });
    await w.app.getDependency('services').load({ xml: res.file_id });
    return res.file_id;
  });
  await page.waitForFunction((expectedXml) => {
    const app = /** @type {any} */ (window).app;
    return app.getCurrentState().xml === expectedXml && app.getCurrentState().editorReadOnly === false;
  }, stableId, { timeout: 20000 });
}

/**
 * Adds three diagnostics of the source `e2e-test` to the editor: two with a
 * fix that inserts a comment before an element, one without a fix. They are
 * re-merged whenever another source replaces the diagnostic set, and dropped
 * once dismissed or applied, like a plugin's own diagnostics.
 * @param {Page} page
 * @returns {Promise<void>}
 */
async function injectDiagnostics(page) {
  await page.evaluate((source) => {
    const app = /** @type {any} */ (window).app;
    const lintUtils = app.getDependency('lint-utils');
    const xmleditor = app.getDependency('xmleditor');
    const view = xmleditor.getView();
    const text = view.state.doc.toString();
    const at = (/** @type {string} */ needle) => {
      const from = text.indexOf(needle);
      if (from === -1) throw new Error(`"${needle}" not in document`);
      return { from, to: from + needle.length };
    };
    /** @type {any[]} */
    let items = [
      {
        ...at('<front'), severity: 'info', message: 'fix A', replacement: '<!--A--><front',
        actions: [{ name: 'Propose fix', apply: (/** @type {any} */ _view, /** @type {number} */ from, /** @type {number} */ to) => { (/** @type {any} */ (window)).proposedFix = [from, to]; } }]
      },
      { ...at('<body'), severity: 'info', message: 'fix B', replacement: '<!--B--><body' },
      { ...at('<TEI'), severity: 'warning', message: 'no fix C' },
    ];
    let rendering = false;
    const render = (/** @type {boolean} */ openPanel) => {
      const doc = xmleditor.getView().state.doc.toString();
      // keep only items whose text is still in place (positions shift after a fix)
      const own = items.map(d => {
        const from = doc.indexOf(d.needle ?? (d.needle = text.slice(d.from, d.to)));
        return from === -1 ? null : { ...d, from, to: from + d.needle.length };
      }).filter(Boolean);
      rendering = true;
      try {
        lintUtils.applyMergedDiagnostics(xmleditor.getView(), source, own, { openPanel });
      } finally {
        rendering = false;
      }
    };
    xmleditor.addUpdateListener((/** @type {any} */ update) => {
      if (lintUtils.replacesDiagnostics(update) && !rendering) setTimeout(() => render(false), 0);
    });
    lintUtils.addDismissListener((/** @type {any[]} */ dismissed) => {
      items = items.filter(d => !dismissed.some(x => x.source === source && x.message === d.message));
    });
    render(true);
  }, SOURCE);
}

/**
 * Returns the drawer's state and its entries of the test source.
 * @param {Page} page
 * @returns {Promise<{empty: boolean, retracted: boolean, panelVisible: boolean, buttonVisible: boolean, messages: string[]}>}
 */
async function drawerState(page) {
  return page.evaluate((source) => {
    const ui = /** @type {any} */ (window).ui;
    const drawer = ui.pdfViewer.diagnosticsDrawer;
    const panel = drawer.shadowRoot.querySelector('[part="panel"]');
    const panelBox = panel.getBoundingClientRect();
    const wrapperBox = drawer.parentElement.getBoundingClientRect();
    const messages = Array.from(drawer.list.children)
      .filter((/** @type {HTMLElement} */ item) => item.textContent.includes(source))
      .map((/** @type {HTMLElement} */ item) => item.querySelector('.diagnostics-drawer-message').textContent);
    return {
      empty: drawer.classList.contains('empty'),
      retracted: drawer.classList.contains('retracted'),
      panelVisible: getComputedStyle(panel).visibility === 'visible' && panelBox.right > wrapperBox.left,
      buttonVisible: !ui.pdfViewer.diagnosticsButton.hidden,
      messages
    };
  }, SOURCE);
}

/**
 * Checks the checkbox of the entry with the given message.
 * @param {Page} page
 * @param {string} message
 */
async function check(page, message) {
  await page.locator('.diagnostics-drawer-item', { hasText: message }).locator('sl-checkbox').click();
}

test.describe('Diagnostics drawer', () => {

  test('lists, retracts, selects, applies and dismisses diagnostics', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadEditableVersion(page);

      await injectDiagnostics(page);
      await expect.poll(async () => (await drawerState(page)).messages).toEqual(['no fix C', 'fix A', 'fix B']);

      // the injected source re-merges after every replacement of the diagnostic set: this must not
      // make it and the other sources replace the set in turn forever (#647)
      const replacements = await page.evaluate(async () => {
        const app = /** @type {any} */ (window).app;
        const lintUtils = app.getDependency('lint-utils');
        let count = 0;
        app.getDependency('xmleditor').addUpdateListener((/** @type {any} */ u) => { if (lintUtils.replacesDiagnostics(u)) count++; });
        await new Promise(resolve => setTimeout(resolve, 1000));
        return count;
      });
      expect(replacements).toBeLessThan(5);

      // the lint gutter tooltip opens next to its marker, not at the top left of the window (#647)
      const marker = page.locator('#codemirror-container .cm-lint-marker').first();
      await marker.scrollIntoViewIfNeeded();
      const markerBox = await marker.boundingBox();
      await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
      const tooltip = page.locator('#codemirror-container .cm-tooltip-lint');
      await expect(tooltip).toBeVisible();
      const tooltipBox = await tooltip.boundingBox();
      expect(Math.abs(tooltipBox.x - markerBox.x)).toBeLessThan(50);
      expect(Math.abs(tooltipBox.y - (markerBox.y + markerBox.height))).toBeLessThan(50);
      await page.mouse.move(0, 0);
      await expect(tooltip).toBeHidden();

      // the drawer stays open permanently, which must not hide the help icon
      await expect(page.locator('div[name="helpIcon"]')).toBeVisible();

      // polled: whenever the diagnostic set is replaced (e.g. by a validation run), the injected
      // diagnostics are missing until they are re-merged, like a plugin's own diagnostics
      await expect.poll(async () => {
        const { empty, retracted, panelVisible, buttonVisible } = await drawerState(page);
        return { empty, retracted, panelVisible, buttonVisible };
      }).toEqual({ empty: false, retracted: false, panelVisible: true, buttonVisible: false });

      // focus in the PDF viewer slides the drawer out, the floating button brings it back
      const box = await page.locator('#pdf-viewer-wrapper').boundingBox();
      await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
      await expect.poll(async () => (await drawerState(page)).retracted).toBe(true);
      await expect.poll(async () => (await drawerState(page)).panelVisible).toBe(false);
      await expect.poll(async () => (await drawerState(page)).buttonVisible).toBe(true);
      await expect(page.locator('.diagnostics-drawer-button sl-badge')).toHaveText('3');
      await page.locator('.diagnostics-drawer-button').click();
      await expect.poll(async () => (await drawerState(page)).panelVisible).toBe(true);
      await expect.poll(async () => (await drawerState(page)).buttonVisible).toBe(false);

      // clicking a diagnostic selects its text in the editor
      await page.locator('.diagnostics-drawer-item', { hasText: 'fix B' }).locator('.diagnostics-drawer-message').click();
      const selected = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const { from, to } = view.state.selection.main;
        return view.state.doc.sliceString(from, to);
      });
      expect(selected).toBe('<body');

      // a diagnostic's actions are buttons called with its current range
      await page.locator('.diagnostics-drawer-item', { hasText: 'fix A' }).locator('.diagnostics-drawer-action').click();
      const proposed = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const text = w.app.getDependency('xmleditor').getView().state.doc.toString();
        const [from, to] = w.proposedFix;
        return text.slice(from, to);
      });
      expect(proposed).toBe('<front');

      // Apply: switches off the merge view, applies the fix, keeps a diagnostic without fix
      await page.evaluate(async () => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        await xmleditor.showMergeView(xmleditor.getView().state.doc.toString().replace('<front', '<front '));
      });
      await check(page, 'fix A');
      await check(page, 'no fix C');
      // click Apply right after the diagnostic set was replaced (as a validation run does), before
      // the injected diagnostics are re-merged: the checked diagnostics must still be applied
      await page.evaluate((source) => {
        const app = /** @type {any} */ (window).app;
        app.getDependency('lint-utils').applyMergedDiagnostics(app.getDependency('xmleditor').getView(), source, []);
        /** @type {HTMLElement} */ (document.querySelector('sl-button[name="applyBtn"]')).click();
      }, SOURCE);
      await expect.poll(async () => (await drawerState(page)).messages).toEqual(['no fix C', 'fix B']);
      const afterApply = await page.evaluate(() => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        return { mergeView: xmleditor.isMergeViewActive(), text: xmleditor.getView().state.doc.toString() };
      });
      expect(afterApply.mergeView).toBe(false);
      expect(afterApply.text).toContain('<!--A--><front');

      // Dismiss: removes the checked diagnostic (C is still checked)
      await page.locator('sl-button[name="dismissBtn"]').click();
      await expect.poll(async () => (await drawerState(page)).messages).toEqual(['fix B']);

      // Select all + Apply
      await page.locator('sl-checkbox[name="selectAll"]').click();
      await page.locator('sl-button[name="applyBtn"]').click();
      await expect.poll(async () => (await drawerState(page)).messages).toEqual([]);
      const text = await page.evaluate(() =>
        (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).toContain('<!--B--><body');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

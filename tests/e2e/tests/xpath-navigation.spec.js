/**
 * XPath navigation end-to-end tests
 *
 * As an annotator, opens the "Navigation XPaths" dialog from the "Edit..." entry of the navigation
 * dropdown, checks that the default of the extractor cannot be changed, that an invalid expression is
 * rejected, adds an expression without a label, navigates with it, renames it and deletes it.
 * Checks that an expression with a wildcard and a predicate stays selected in the dropdown when it
 * replaces another one, and that the index follows the cursor among the nodes it selects.
 * Checks that in focus mode, the up/down arrow keys move the focus to the previous/next node, and
 * that in the visual annotation mode, they always go to the previous/next node like ‹ ›.
 *
 * @testCovers app/src/plugins/xpath-navigation.js
 * @testCovers app/src/templates/xpath-navigation-dialog.html
 * @testCovers app/src/modules/navigation-xpath-utils.js
 * @testCovers app/src/modules/panels/widgets/status-dropdown.js
 * @testCovers fastapi_app/routers/navigation_xpath.py
 * @testCovers fastapi_app/lib/utils/navigation_xpath.py
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

/** A variant of the mock extractor, whose default navigation XPath is `//tei:biblStruct` */
const VARIANT = 'mock-default';

const TEXT_CHILDREN = `<text>
    <listBibl><bibl>Alpha</bibl></listBibl>
    <front>Front matter</front>
    <back/>
    <div>Div text</div>
  </text>`;

const TEXT = `<text>
    <listBibl>
      <bibl>Alpha 2001</bibl>
      <bibl>Beta 2002</bibl>
      <bibl>Gamma 2003</bibl>
      <biblStruct/>
    </listBibl>
  </text>`;

/**
 * Loads an editable copy of the first document with the test <text> and the mock variant.
 * @param {Page} page
 * @param {string} [text] - The <text> element
 * @returns {Promise<string>} The stable id of the copy
 */
async function loadNavigationDocument(page, text = TEXT) {
  const stableId = await page.evaluate(async ({ text, variant }) => {
    const w = /** @type {any} */ (window);
    const xml = w.app.getDependency('xmleditor').getXML()
      .replace(/<standOff[\s\S]*?<\/standOff>\s*/, '')
      .replace(/(<label type="variant-id">)[^<]*(<\/label>)/, `$1${variant}$2`)
      .replace(/<text[\s>][\s\S]*<\/text>/, text);
    const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'xpath-navigation-probe', new_version: true });
    // the file data must know the variant of the new version before it is loaded
    await w.app.getDependency('filedata').reload({ refresh: true });
    await w.app.getDependency('services').load({ xml: res.file_id });
    return res.file_id;
  }, { text, variant: VARIANT });
  await page.waitForFunction(({ expectedXml, variant }) => {
    const state = /** @type {any} */ (window).app.getCurrentState();
    return state.xml === expectedXml && state.variant === variant && state.editorReadOnly === false;
  }, { expectedXml: stableId, variant: VARIANT }, { timeout: 20000 });
  return stableId;
}

/**
 * Opens the navigation dropdown and clicks an entry
 * @param {Page} page
 * @param {string|RegExp} text
 */
async function clickDropdownEntry(page, text) {
  const dropdown = page.locator('status-dropdown[name="xpathDropdown"]');
  await dropdown.locator('.trigger-content').click();
  const entry = dropdown.locator('sl-menu-item', { hasText: text });
  await expect(entry).toBeVisible();
  await entry.click();
}

/**
 * The `xpath` state, the dropdown selection and the counter text
 * @param {Page} page
 * @returns {Promise<{xpath: string|null, selected: string, counter: string}>}
 */
async function navigationState(page) {
  return page.evaluate(() => ({
    xpath: (/** @type {any} */ (window)).app.getCurrentState().xpath,
    selected: /** @type {any} */ (document.querySelector('status-dropdown[name="xpathDropdown"]')).selected,
    counter: /** @type {any} */ (document.querySelector('[name="nodeCounterWidget"]')).text
  }));
}

/**
 * The texts of the selectable dropdown entries
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
async function dropdownTexts(page) {
  return page.evaluate(() => {
    const dropdown = /** @type {any} */ (document.querySelector('status-dropdown[name="xpathDropdown"]'));
    return (dropdown?.items ?? []).filter(item => !item.action && !item.divider).map(item => item.value);
  });
}

test.describe('XPath navigation', () => {

  test('annotators add, use, rename and delete navigation XPaths', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadNavigationDocument(page);

      await expect.poll(() => dropdownTexts(page)).toEqual(['//tei:biblStruct']);

      // the dialog lists the default of the extractor, which cannot be changed
      await clickDropdownEntry(page, 'Edit...');
      const dialog = page.locator('sl-dialog[name="xpathNavigationDialog"]');
      await expect(dialog).toHaveAttribute('open', '');
      const list = page.getByTestId('xpath-navigation-list');
      const defaultRow = list.locator('tr[data-value="//tei:biblStruct"]');
      await expect(defaultRow).toContainText('Default');
      await expect(defaultRow.getByTestId('delete-btn')).toHaveCount(0);
      await page.waitForTimeout(500);

      const xpathInput = dialog.locator('sl-input[name="xpathInput"] input');
      const labelInput = dialog.locator('sl-input[name="labelInput"] input');
      const submitBtn = dialog.locator('sl-button[name="submitBtn"]');
      const error = dialog.locator('[name="xpathError"]');

      // invalid expressions are rejected
      await xpathInput.fill('//tei:bibl[');
      await submitBtn.click();
      await expect(error).toContainText('Invalid XPath');
      await xpathInput.fill('//foo:bibl');
      await submitBtn.click();
      await expect(error).toContainText('Unknown namespace prefix');
      await xpathInput.fill('//tei:biblStruct');
      await submitBtn.click();
      await expect(error).toContainText('provided by the extractor');

      // an entry without a label shows the expression
      await xpathInput.fill('//tei:listBibl/tei:bibl');
      await submitBtn.click();
      const row = list.locator('tr[data-value="//tei:listBibl/tei:bibl"]');
      await expect(row).toContainText('//tei:listBibl/tei:bibl');
      await expect.poll(() => dropdownTexts(page)).toEqual(['//tei:biblStruct', '//tei:listBibl/tei:bibl']);
      const stored = await page.evaluate(async (variant) =>
        (await (/** @type {any} */ (window)).client.apiClient.navigationXpathList()).variants[variant], VARIANT);
      expect(stored).toEqual([
        { value: '//tei:biblStruct', label: '<biblStruct>', edit: false },
        { value: '//tei:listBibl/tei:bibl', label: '//tei:listBibl/tei:bibl', edit: true }
      ]);

      // navigate with the new entry
      await dialog.locator('sl-button[name="closeBtn"]').click();
      await expect(dialog).not.toHaveAttribute('open', '');
      await clickDropdownEntry(page, '//tei:listBibl/tei:bibl');
      await expect.poll(() => page.evaluate(() => (/** @type {any} */ (window)).app.getCurrentState().xpath))
        .toBe('//tei:listBibl/tei:bibl[1]');
      await expect(page.locator('[name="nodeCounterWidget"]')).toContainText('(1/3)');

      // rename it
      await clickDropdownEntry(page, 'Edit...');
      await expect(dialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);
      await row.getByTestId('edit-btn').click();
      await expect(xpathInput).toHaveValue('//tei:listBibl/tei:bibl');
      await labelInput.fill('<bibl> in list');
      await submitBtn.click();
      await expect(row).toContainText('<bibl> in list');
      await expect.poll(() => page.evaluate(() => {
        const dropdown = /** @type {any} */ (document.querySelector('status-dropdown[name="xpathDropdown"]'));
        return dropdown.items.find(item => item.value === '//tei:listBibl/tei:bibl')?.text;
      })).toBe('&lt;bibl&gt; in list');

      // deleting the selected entry turns the navigation off
      await row.getByTestId('delete-btn').click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => dropdownTexts(page)).toEqual(['//tei:biblStruct']);
      await expect.poll(() => page.evaluate(() => (/** @type {any} */ (window)).app.getCurrentState().xpath))
        .toBeFalsy();
    } finally {
      await page.evaluate(async (variant) => {
        try {
          await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, { entries: [] });
        } catch { /* nothing to clean up */ }
      }, VARIANT).catch(() => {});
      await releaseAllLocks(page).catch(() => {});
      stopErrorMonitoring();
    }
  });

  test('the dropdown keeps an expression with a wildcard and a predicate', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    const CHILDREN = '/tei:TEI/tei:text/*[normalize-space()]';

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.evaluate(async ({ variant, children }) => {
        await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, {
          entries: [{ value: '//tei:listBibl', label: 'listBibl' }, { value: children, label: '' }]
        });
      }, { variant: VARIANT, children: CHILDREN });
      await loadNavigationDocument(page, TEXT_CHILDREN);
      // reload the entries
      await page.reload();
      await expect.poll(() => dropdownTexts(page)).toContain(CHILDREN);

      // the first non-empty child of <text> is the <listBibl> selected before
      await clickDropdownEntry(page, 'listBibl');
      await expect.poll(() => navigationState(page)).toEqual({ xpath: '//tei:listBibl[1]', selected: '//tei:listBibl', counter: '(1/1)' });
      await clickDropdownEntry(page, CHILDREN);
      await expect.poll(() => navigationState(page)).toEqual({ xpath: `${CHILDREN}[1]`, selected: CHILDREN, counter: '(1/3)' });
      await page.waitForTimeout(1000);
      expect(await navigationState(page)).toEqual({ xpath: `${CHILDREN}[1]`, selected: CHILDREN, counter: '(1/3)' });

      // the index counts only the nodes that the predicate selects: <back/> is empty
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Div text') + 2 } });
      });
      await expect.poll(() => navigationState(page)).toEqual({ xpath: `${CHILDREN}[3]`, selected: CHILDREN, counter: '(3/3)' });
    } finally {
      await page.evaluate(async (variant) => {
        try {
          await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, { entries: [] });
        } catch { /* nothing to clean up */ }
      }, VARIANT).catch(() => {});
      await releaseAllLocks(page).catch(() => {});
      stopErrorMonitoring();
    }
  });

  test('in focus mode, the arrow keys move the focus to the previous/next node', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    const BIBL = '//tei:listBibl/tei:bibl';

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.evaluate(async ({ variant, bibl }) => {
        await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, {
          entries: [{ value: bibl, label: 'bibl' }]
        });
      }, { variant: VARIANT, bibl: BIBL });
      await loadNavigationDocument(page, TEXT.replace('Beta 2002', 'Beta\n        2002'));
      await page.reload();
      await expect.poll(() => dropdownTexts(page)).toContain(BIBL);
      await clickDropdownEntry(page, 'bibl');
      await expect.poll(() => navigationState(page)).toEqual({ xpath: `${BIBL}[1]`, selected: BIBL, counter: '(1/3)' });
      await expect.poll(() => page.evaluate(() =>
        (/** @type {any} */ (window)).app.getDependency('xmleditor').isFocusMode())).toBe(true);

      // in the editor text, the cursor moves line by line within the focused node, and from its
      // first/last line to the previous/next node, which is centered
      const cursorLine = () => page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        return view.state.doc.lineAt(view.state.selection.main.head).text.trim();
      });
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().focus());
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[2]`);
      expect(await cursorLine()).toBe('<bibl>Beta');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(500);
      expect((await navigationState(page)).xpath).toBe(`${BIBL}[2]`);
      expect(await cursorLine()).toBe('2002</bibl>');
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[3]`);
      expect(await cursorLine()).toBe('<bibl>Gamma 2003</bibl>');
      await page.keyboard.press('ArrowUp');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[2]`);

      // outside the editor text, e.g. after clicking a navigation button
      await page.locator('[name="nextNodeBtn"]').click();
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[3]`);
      await page.keyboard.press('ArrowUp');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[2]`);
      await page.keyboard.press('ArrowUp');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[1]`);
      // no wrapping around at the first node
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(500);
      expect((await navigationState(page)).xpath).toBe(`${BIBL}[1]`);
    } finally {
      await page.evaluate(async (variant) => {
        try {
          await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, { entries: [] });
        } catch { /* nothing to clean up */ }
      }, VARIANT).catch(() => {});
      await releaseAllLocks(page).catch(() => {});
      stopErrorMonitoring();
    }
  });

  test('in the visual mode, the arrow keys go to the previous/next node like the buttons', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    const BIBL = '//tei:listBibl/tei:bibl';

    // the visual mode needs annotation tags for the variant
    await page.route('**/api/v1/extract/list', async route => {
      const response = await route.fetch();
      const extractors = await response.json();
      const extractor = Array.isArray(extractors) && extractors.find(e => e.variants?.includes(VARIANT));
      if (!extractor) return route.fulfill({ response });
      extractor.annotationTags = { ...extractor.annotationTags, [VARIANT]: [{ tag: 'bibl', label: 'Bibl', color: '#cc6600' }] };
      await route.fulfill({ response, json: extractors });
    });

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.evaluate(async ({ variant, bibl }) => {
        await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, {
          entries: [{ value: bibl, label: 'bibl' }]
        });
      }, { variant: VARIANT, bibl: BIBL });
      await loadNavigationDocument(page, TEXT.replace('Beta 2002', 'Beta\n        2002'));
      await page.reload();
      await expect.poll(() => dropdownTexts(page)).toContain(BIBL);
      await clickDropdownEntry(page, 'bibl');
      await expect.poll(() => navigationState(page)).toEqual({ xpath: `${BIBL}[1]`, selected: BIBL, counter: '(1/3)' });

      // without focus mode, too
      await page.locator('[name="focusToggle"]').click();
      await expect.poll(() => page.evaluate(() =>
        (/** @type {any} */ (window)).app.getDependency('xmleditor').isFocusMode())).toBe(false);
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation').dispatchStateChange({ view: 'annotation' }));
      await page.waitForFunction(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').isReadOnly());

      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().focus());
      // the multi-line <bibl> is skipped in one step, the cursor does not move within it
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[2]`);
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[3]`);
      // wraps around like ›
      await page.keyboard.press('ArrowDown');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[1]`);
      await page.keyboard.press('ArrowUp');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[3]`);
      await page.keyboard.press('ArrowUp');
      await expect.poll(async () => (await navigationState(page)).xpath).toBe(`${BIBL}[2]`);
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation')?.dispatchStateChange({ view: null })).catch(() => {});
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xpath-navigation')?.uiStorage.remove('focusMode')).catch(() => {});
      await page.evaluate(async (variant) => {
        try {
          await (/** @type {any} */ (window)).client.apiClient.navigationXpathSave(variant, { entries: [] });
        } catch { /* nothing to clean up */ }
      }, VARIANT).catch(() => {});
      await releaseAllLocks(page).catch(() => {});
      stopErrorMonitoring();
    }
  });
});

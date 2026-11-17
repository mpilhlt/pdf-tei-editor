/**
 * XPath navigation end-to-end tests
 *
 * As an annotator, opens the "Navigation XPaths" dialog from the "Edit..." entry of the navigation
 * dropdown, checks that the default of the extractor cannot be changed, that an invalid expression is
 * rejected, adds an expression without a label, navigates with it, renames it and deletes it.
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
 * @returns {Promise<string>} The stable id of the copy
 */
async function loadNavigationDocument(page) {
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
  }, { text: TEXT, variant: VARIANT });
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
 * The texts of the selectable dropdown entries
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
async function dropdownTexts(page) {
  return page.evaluate(() => {
    const dropdown = /** @type {any} */ (document.querySelector('status-dropdown[name="xpathDropdown"]'));
    return dropdown.items.filter(item => !item.action && !item.divider).map(item => item.value);
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
});

/**
 * TEI Wizard end-to-end tests
 *
 * As an annotator, opens the TEI Wizard menu of the XML editor toolbar, checks that it lists the
 * enhancements that apply to the document, runs Pretty Print XML with a review unit path and checks
 * the result shown in the merge view: each unit on its own line with its content unchanged, and the
 * mixed content of the header left as it is.
 *
 * @testCovers fastapi_app/plugins/tei_wizard/extensions/tei-wizard.js
 * @testCovers fastapi_app/plugins/tei_wizard/enhancements/pretty-print-xml.js
 * @testCovers fastapi_app/plugins/tei_wizard/routes.py
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

const TEXT = '<text><listBibl><bibl><author>Alpha</author> <title>One</title></bibl><bibl><author>Beta</author> <title>Two</title></bibl></listBibl></text>';

const LICENCE = '<licence>See <ref target="a">A</ref> <ref target="b">B</ref>.</licence>';

/**
 * Loads an editable copy of the first document with the test <text> and a licence with mixed
 * content in the header.
 * @param {Page} page
 * @returns {Promise<string>} The stable id of the copy
 */
async function loadWizardDocument(page) {
  const stableId = await page.evaluate(async ({ text, licence }) => {
    const w = /** @type {any} */ (window);
    let xml = w.app.getDependency('xmleditor').getXML()
      .replace(/<standOff[\s\S]*?<\/standOff>\s*/, '')
      .replace(/<text[\s>][\s\S]*<\/text>/, text);
    xml = xml.includes('</publicationStmt>')
      ? xml.replace('</publicationStmt>', `<availability>${licence}</availability></publicationStmt>`)
      : xml.replace('</titleStmt>', `</titleStmt><publicationStmt><availability>${licence}</availability></publicationStmt>`);
    const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'tei-wizard-probe', new_version: true });
    await w.app.getDependency('services').load({ xml: res.file_id });
    return res.file_id;
  }, { text: TEXT, licence: LICENCE });
  await page.waitForFunction((expectedXml) => {
    const app = /** @type {any} */ (window).app;
    return app.getCurrentState().xml === expectedXml && app.getCurrentState().editorReadOnly === false;
  }, stableId, { timeout: 20000 });
  return stableId;
}

test.describe('TEI Wizard', () => {

  test('lists the applicable enhancements and pretty-prints by review units', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadWizardDocument(page);

      // the test setup has no extractor with review units: configure one for the document, and
      // record what the enhancement passes to the merge view
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.app.getDependency('unit-review').getUnitPath = () => './/listBibl/bibl';
        const xmleditor = w.app.getDependency('xmleditor');
        const showMergeView = xmleditor.showMergeView.bind(xmleditor);
        xmleditor.showMergeView = (/** @type {string} */ xml) => {
          w.__teiWizardResult = xml;
          return showMergeView(xml);
        };
      });

      const button = page.locator('sl-button[name="teiWizardBtn"]');
      await expect(button).toBeEnabled({ timeout: 10000 });
      await button.click();

      const items = page.locator('sl-menu[name="teiWizardMenu"] sl-menu-item');
      await expect(items.first()).toBeVisible();
      const labels = (await items.allTextContents()).map(label => label.trim());
      expect(labels).toContain('Pretty Print XML');
      // superseded by the LLM review
      expect(labels).not.toContain('Fix Common Extraction Issues');
      expect(labels).not.toContain('Convert XML comments');

      await items.filter({ hasText: 'Pretty Print XML' }).click();
      await page.waitForFunction(() => {
        const w = /** @type {any} */ (window);
        return Boolean(w.__teiWizardResult) && w.app.getDependency('xmleditor').isMergeViewActive();
      }, null, { timeout: 10000 });

      const result = await page.evaluate(() => /** @type {any} */ (window).__teiWizardResult);
      // one unit per line, content unchanged
      expect(result).toMatch(/\n\s+<bibl><author>Alpha<\/author> <title>One<\/title><\/bibl>\n\s+<bibl><author>Beta<\/author> <title>Two<\/title><\/bibl>/);
      // mixed content in the header is kept
      expect(result).toContain(LICENCE);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});

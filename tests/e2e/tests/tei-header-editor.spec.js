/**
 * TEI Header Editor E2E tests
 *
 * Covers the teiHeader editor dialog's happy-path round-trip (editing
 * publicationStmt/publisher as a reviewer, saving, reloading) and the
 * pure-annotator role gate (the toolbar button is hidden entirely for
 * annotator-only users - see acl-utils.js's userIsAnnotatorOnly()).
 *
 * The dialog renders a fixed list of plain fields (see FIELD_DEFS in
 * app/src/modules/tei-header-form.js) rather than a schema-derived
 * recursive tree - see docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md's
 * "Revision 2" for why. This test also asserts the save is diff-based:
 * editing one field (publisher) must leave an untouched nested structure
 * (titleStmt's existing multi-author persName/forename/surname markup,
 * plus its respStmt) byte-identical, which is the specific property the
 * "Revision 2" rewrite exists to guarantee. (The standard E2E fixture's
 * sourceDesc has only a plain bibl, no biblStruct - titleStmt is the
 * richest untouched structure actually available to snapshot.)
 *
 * @testCovers app/src/plugins/tei-header-editor.js
 * @testCovers app/src/modules/tei-header-form.js
 * @testCovers app/src/modules/acl-utils.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'offsetParent is not set.*cannot scroll',
  'Failed to load resource.*403.*FORBIDDEN',
  'Failed to load resource.*423.*LOCKED',
];

/**
 * Opens the teiHeader editor dialog for the currently loaded document.
 * @param {import('@playwright/test').Page} page
 */
async function openHeaderEditor(page) {
  await page.click('[name="headerEditorBtn"]');
  const dialog = page.locator('sl-dialog[name="teiHeaderEditorDialog"]');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500); // Shoelace dialog animation, per tests/CLAUDE.md
}

test.describe('TEI Header Editor', () => {
  test('reviewer can edit publisher and save, leaving an untouched titleStmt intact', async ({ page }) => {
    test.setTimeout(60000);

    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForSelector('#codemirror-container .cm-editor');
      await page.waitForFunction(() => {
        const app = /** @type {any} */ (window).app;
        const xmlEditor = app && app.getDependency('xmleditor');
        const view = xmlEditor && xmlEditor.getView();
        return view && view.state.doc.length > 0;
      }, { timeout: 15000 });
      await page.waitForTimeout(500);

      // Snapshot the fixture's existing titleStmt markup (real nested
      // multi-author <persName><forename/><surname/></persName> structure
      // plus a respStmt) before touching anything, so we can assert it
      // survives untouched below even though publisher - not title - is
      // what gets edited and saved.
      const titleStmtBefore = await page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        const xmlTree = app.getDependency('xmleditor').getXmlTree();
        const titleStmt = xmlTree.getElementsByTagName('titleStmt')[0];
        return titleStmt ? titleStmt.outerHTML : null;
      });
      expect(titleStmtBefore, 'fixture must have a titleStmt to make this test meaningful').not.toBeNull();
      expect(titleStmtBefore, 'fixture must have nested author structure to make this test meaningful').toContain('<persName>');

      await openHeaderEditor(page);

      const publisherInput = page.locator('sl-input[data-field="publisher"]');
      await expect(publisherInput).toBeVisible();
      await publisherInput.locator('input').fill('Test Publisher E2E');

      const dialog = page.locator('sl-dialog[name="teiHeaderEditorDialog"]');
      await dialog.locator('sl-button[name="saveBtn"]').click();
      await expect(dialog).not.toBeVisible({ timeout: 10000 });

      await page.reload();
      await page.waitForSelector('#codemirror-container .cm-editor');
      await page.waitForFunction(() => {
        const app = /** @type {any} */ (window).app;
        const xmlEditor = app && app.getDependency('xmleditor');
        const view = xmlEditor && xmlEditor.getView();
        return view && view.state.doc.length > 0;
      }, { timeout: 15000 });
      await page.waitForTimeout(500);

      // The edited field persisted...
      await openHeaderEditor(page);
      await expect(page.locator('sl-input[data-field="publisher"] input')).toHaveValue('Test Publisher E2E');

      // ...and the untouched titleStmt is byte-identical to before.
      const titleStmtAfter = await page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        const xmlTree = app.getDependency('xmleditor').getXmlTree();
        const titleStmt = xmlTree.getElementsByTagName('titleStmt')[0];
        return titleStmt ? titleStmt.outerHTML : null;
      });
      expect(titleStmtAfter).toBe(titleStmtBefore);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });

  test('pure annotator does not see the header-editor button', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      await page.waitForTimeout(1000);

      await expect(page.locator('[name="headerEditorBtn"]')).toBeHidden();
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});

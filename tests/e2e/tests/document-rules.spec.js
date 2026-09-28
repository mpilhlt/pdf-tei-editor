/**
 * Document rules registry E2E tests
 *
 * Covers the "Edit prompts/schemas" submenu (resource discovery, override
 * CRUD on the schema resource) and the reviewer-only "Refresh document
 * rules" action.
 *
 * The interpretation-ref resource's original text is only ever fetched
 * from a real annotation-guide URL (mpilhlt/fossil on GitHub) - see
 * fastapi_app/lib/doc_rules/interpretation_ref_kind.py's resolve_original().
 * Opening its editor is intentionally NOT exercised here to avoid a flaky
 * dependency on that specific external repository's content; only its
 * presence in the submenu is asserted, which only needs discover() (no
 * fetch - see fastapi_app/lib/doc_rules/interpretation_ref_kind.py's
 * discover()). The schema resource IS opened, because its original text
 * resolves via the schema-validation cache mechanism against a URL already
 * fetched routinely by this app (fastapi_app/lib/core/schema_validator.py).
 *
 * "Refresh document rules" itself does depend on live network access to
 * GitHub (github.com + raw.githubusercontent.com, via
 * fastapi_app/plugins/grobid/annotation_rules.py's resolve_forge_permalink /
 * translate_anchor_to_line_range) to permalink-pin the annotation guide -
 * this is inherent to the feature (confirmed by grep: every existing unit
 * test for that code path mocks the network call), not something this test
 * can avoid while still exercising a real success outcome.
 *
 * @testCovers app/src/plugins/document-rules.js
 * @testCovers fastapi_app/lib/doc_rules/interpretation_ref_kind.py
 * @testCovers fastapi_app/lib/doc_rules/schema_kind.py
 * @testCovers fastapi_app/lib/doc_rules/rules_refresh.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
];

// Must match the xml-model href in document-rules-fixture.tei.xml exactly -
// used to look up (and clean up) the schema resource's overrides directly.
const SCHEMA_URL = 'https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/main/schema/rng/tei-bib.rng';

/**
 * Open the Tools dropdown menu, revealing its items for hover/click.
 * @param {import('@playwright/test').Page} page
 */
async function openToolsMenu(page) {
  await page.click('sl-dropdown[name="toolsDropdown"] sl-button[name="toolsBtn"]');
  await page.waitForTimeout(500);
}

/**
 * Look up a pre-seeded fixture document's stable id by its doc_id (the
 * filename without extension - see tests/lib/fixture-loader.js) and load it
 * into the editor via the services plugin, then wait for its content to
 * actually be fetched and rendered.
 * @param {import('@playwright/test').Page} page
 * @param {string} docId
 * @returns {Promise<string>} the resolved stable id
 */
async function loadFixtureDocument(page, docId) {
  const stableId = await page.evaluate(async (id) => {
    const result = await window.client.apiClient.filesList();
    const group = result.files.find((f) => f.doc_id === id);
    return group ? group.source.id : null;
  }, docId);
  expect(stableId, `fixture document "${docId}" not found via filesList()`).toBeTruthy();

  // services.load() (not app.updateState()) is the real content-loading
  // path: it fetches the file and populates the XML editor. updateState()
  // alone only sets state.xml without fetching/rendering anything, which is
  // enough for the "Refresh document rules" flow (server-side, keyed only
  // by the stable id) but not for this helper's callers, which need the
  // editor's live document text (documentRulesList({xml_string})).
  await page.evaluate(
    (id) => /** @type {any} */ (window).app.getDependency('services').load({ xml: id }),
    stableId
  );
  // Scoped to the main editor's own container: a generic '.cm-editor'
  // selector also matches document-rules.js's own (initially hidden)
  // CodeMirror instance for the schema body, which exists from app
  // startup onward and would make this wait resolve immediately.
  await page.waitForSelector('#codemirror-container .cm-editor');
  await page.waitForFunction(() => {
    const xmlEditor = /** @type {any} */ (window).app.getDependency('xmleditor');
    const view = xmlEditor.getView();
    return view && view.state.doc.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(500);
  return stableId;
}

test.describe('Document rules registry', () => {
  test('lists both resources in the submenu and edits an override on the schema resource', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await loadFixtureDocument(page, 'document-rules-fixture');

      await openToolsMenu(page);
      // The "Edit prompts/schemas" item starts hidden (display:none) until
      // its own POST /document-rules/list resolves for the just-loaded
      // document (app/src/plugins/document-rules.js's onXmlChange() ->
      // _refreshResources()), so wait for it to become visible before
      // hovering it rather than relying on a fixed timeout.
      const editMenuItem = page.locator('sl-menu-item:has-text("Edit prompts/schemas")');
      await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
      await editMenuItem.hover();
      await page.waitForTimeout(500);

      const submenu = page.locator('sl-menu-item:has-text("Edit prompts/schemas") sl-menu[slot="submenu"]');
      await expect(submenu.locator('sl-menu-item')).toHaveCount(2);
      const labels = await submenu.locator('sl-menu-item').allTextContents();
      expect(labels.some((label) => label.includes('Data correction'))).toBe(true);
      expect(labels.some((label) => label.includes('Schema (RelaxNG)'))).toBe(true);

      // Open the schema resource and confirm the CodeMirror body starts
      // read-only, showing "Original" selected.
      await submenu.locator('sl-menu-item:has-text("Schema (RelaxNG)")').click();
      const dialog = page.locator('sl-dialog[name="documentRulesEditorDialog"]');
      await expect(dialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);

      // Scoped to the override row (not the whole dialog): the footer's
      // "Reset to original" button also contains the substring "original"
      // and would otherwise make this locator ambiguous.
      const overrideRow = dialog.locator('[name="overrideRow"]');
      const originalBtn = overrideRow.locator('sl-button:has-text("Original")');
      const xmlContent = dialog.locator('[name="xmlContainer"] .cm-content');
      await expect(xmlContent).toHaveAttribute('contenteditable', 'false');
      await expect(originalBtn).toHaveAttribute('variant', 'primary');

      // New override: the row selects "Override 1" and the body becomes editable.
      await dialog.locator('sl-button:has-text("New override")').click();
      await page.waitForTimeout(500);
      const override1Btn = overrideRow.locator('sl-button:has-text("Override 1")');
      await expect(override1Btn).toHaveAttribute('variant', 'primary');
      await expect(xmlContent).toHaveAttribute('contenteditable', 'true');

      // Reset to original: reverts the selection and the body's read-only state.
      await dialog.locator('sl-button[name="resetBtn"]').click();
      await page.waitForTimeout(500);
      await expect(originalBtn).toHaveAttribute('variant', 'primary');
      await expect(xmlContent).toHaveAttribute('contenteditable', 'false');

      await dialog.locator('sl-button[name="closeBtn"]').click();
      await page.waitForTimeout(500);

      // Clean up the override created above via a direct API call rather
      // than more dialog clicks: this app's dialog stacking made a second
      // sl-dialog (the generic confirm dialog Delete would need) unclickable
      // while documentRulesEditorDialog was still open (its content
      // intercepted the pointer event). resource_overrides rows have no
      // TTL/cascade-delete (see fastapi_app/lib/doc_rules/storage.py), so a
      // leftover "Override 1" would otherwise survive into the next run/CI
      // retry against the same DB and make the "New override" assertion
      // above fail there (a second run would create "Override 2" instead).
      await page.evaluate(async (schemaUrl) => {
        const client = /** @type {any} */ (window).client;
        const query = await client.apiClient.documentRulesQuery({ kind: 'schema', url: schemaUrl });
        for (const override of query.overrides) {
          await client.apiClient.documentRulesDeleteOverrides(override.id);
        }
      }, SCHEMA_URL);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });

  test('refreshes document rules on a legacy-style fixture (appInfo but no editorialDecl) and reports success', async ({ page }) => {
    // Preview/execute both resolve a live GitHub permalink (see this file's
    // header comment); the two 15s timeouts below alone approach Playwright's
    // default 30s per-test ceiling once login/menu/navigation time is added,
    // so this would fail on ordinary network latency, not just an outage.
    test.setTimeout(60000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await loadFixtureDocument(page, 'document-rules-legacy-fixture');

      await openToolsMenu(page);
      await page.click('sl-menu-item:has-text("Refresh document rules")');

      // The preview call itself resolves the annotation guide against a
      // real GitHub commit (see this file's header comment), so give it
      // more room than the usual Shoelace-dialog-timing 500ms before
      // expecting the confirm dialog to be open.
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await expect(confirmDialog).toHaveAttribute('open', '', { timeout: 15000 });
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();

      await expect(page.locator('sl-alert[variant="success"]')).toBeVisible({ timeout: 15000 });
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });
});

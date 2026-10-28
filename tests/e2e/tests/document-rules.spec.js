/**
 * Document rules registry E2E tests
 *
 * Covers the "Edit document rules" submenu (resource discovery, override
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
 * the extractor plugin's rules provider, resolve_forge_permalink /
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

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
];

// Must match the xml-model href in document-rules-fixture.tei.xml exactly -
// used to look up (and clean up) the schema resource's overrides directly.
const SCHEMA_URL = 'https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/main/schema/rng/tei-bib.rng';

// Must match the <ref target="..."> in document-rules-fixture.tei.xml's
// "Data correction" interpretation entry exactly.
const INTERPRETATION_REF_URL = 'https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#data-correction';

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

const TWO_LAYER_PORT = 38417;
const TWO_LAYER_RULE_URLS = [
  `http://127.0.0.1:${TWO_LAYER_PORT}/guide.md#data-correction`,
  `http://127.0.0.1:${TWO_LAYER_PORT}/machine.md#L1-L3`
];
const PROPOSED_MACHINE_TEXT = '# Data correction\n\nProposed machine rule text.\n';

/**
 * Serve the two-layer fixtures (tests/e2e/fixtures/rules-markdown/) over HTTP:
 * the backend fetches rule text server-side, so page.route() cannot mock it.
 * @param {number} port
 * @returns {Promise<http.Server>}
 */
async function startRulesServer(port) {
  const rulesDir = fileURLToPath(new URL('../fixtures/rules-markdown/', import.meta.url));
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '').split('#')[0].replace(/^\//, '');
    if (name !== 'guide.md' && name !== 'machine.md') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end(readFileSync(rulesDir + name));
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(`Could not start the rules markdown server on port ${port}: ${err.message}`)));
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
  return server;
}

/**
 * Delete every override of the given interpretation-ref urls (overrides have no TTL).
 * @param {import('@playwright/test').Page} page
 * @param {string[]} urls
 */
async function deleteRuleOverrides(page, urls) {
  await page.evaluate(async (ruleUrls) => {
    const client = /** @type {any} */ (window).client;
    for (const url of ruleUrls) {
      const query = await client.apiClient.documentRulesQuery({ kind: 'interpretation-ref', url });
      for (const override of query.overrides) {
        await client.apiClient.documentRulesDeleteOverrides(override.id);
      }
    }
  }, urls).catch((err) => console.warn('document-rules E2E cleanup failed:', err));
}

/**
 * Mock the LLM endpoints inference-settings reads (it fetches them at start
 * and on session change, so call this before navigateAndLogin()).
 * @param {import('@playwright/test').Page} page
 * @param {Array<{id: string, label: string, models: Array<{id: string, label: string}>}>} providers
 */
async function mockLlm(page, providers) {
  await page.route('**/api/v1/llm/providers', (route) => route.fulfill({
    json: providers.map((p) => ({
      ...p,
      models: p.models.map((m) => ({ ...m, capabilities: [], status: null, free: true })),
      key_required: false,
      secret_service: null,
      error: null
    }))
  }));
  await page.route('**/api/v1/llm/default-model', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: null })
    : route.continue());
}

/**
 * Open the "Data correction" editor dialog of the two-layer fixture on its machine tab.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<import('@playwright/test').Locator>} the editor dialog
 */
async function openMachineTab(page) {
  await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
  await loadFixtureDocument(page, 'document-rules-two-layer-fixture');
  await openToolsMenu(page);
  const editMenuItem = page.locator('sl-menu-item:has-text("Edit document rules")');
  await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
  await editMenuItem.hover();
  await page.waitForTimeout(500);
  await page.locator('sl-menu-item:has-text("Edit document rules") sl-menu[slot="submenu"] sl-menu-item:has-text("Data correction")').click();
  const dialog = page.locator('sl-dialog[name="documentRulesEditorDialog"]');
  await expect(dialog).toHaveAttribute('open', '');
  await dialog.locator('sl-tab[name="machineLayerTab"]').click();
  return dialog;
}

test.describe('Document rules registry', () => {
  test('lists both resources in the submenu and edits an override on the schema resource', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await loadFixtureDocument(page, 'document-rules-fixture');

      await openToolsMenu(page);
      // The "Edit document rules" item starts hidden (display:none) until
      // its own POST /document-rules/list resolves for the just-loaded
      // document (app/src/plugins/document-rules.js's onXmlChange() ->
      // _refreshResources()), so wait for it to become visible before
      // hovering it rather than relying on a fixed timeout.
      const editMenuItem = page.locator('sl-menu-item:has-text("Edit document rules")');
      await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
      await editMenuItem.hover();
      await page.waitForTimeout(500);

      const submenu = page.locator('sl-menu-item:has-text("Edit document rules") sl-menu[slot="submenu"]');
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

      // Search/replace: Mod-f opens CodeMirror's search panel in the schema
      // body, and Escape closes the panel without closing the dialog.
      await xmlContent.click();
      await page.keyboard.press('ControlOrMeta+f');
      const searchPanel = dialog.locator('[name="xmlContainer"] .cm-search');
      await expect(searchPanel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(searchPanel).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(dialog).toHaveAttribute('open', '');

      // New override: the row selects "Override 1" and the body becomes editable.
      await dialog.locator('sl-button:has-text("New override")').click();
      await page.waitForTimeout(500);
      const override1Btn = overrideRow.locator('sl-button:has-text("Override 1")');
      await expect(override1Btn).toHaveAttribute('variant', 'primary');
      await expect(xmlContent).toHaveAttribute('contenteditable', 'true');

      // Reset to original: since "Reset to original" now permanently
      // deletes overrides (not just deselects them), _onReset() confirms
      // first - accept that confirm dialog before checking the reverted
      // selection/read-only state.
      await dialog.locator('sl-button[name="resetBtn"]').click();
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await expect(confirmDialog).toHaveAttribute('open', '', { timeout: 5000 });
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
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

  // Skipped in CI (and by default everywhere): preview/execute call
  // fastapi_app/lib/doc_rules/rules_refresh.py, which resolves a live
  // GitHub permalink via two anonymous, synchronous requests.get() calls
  // (fastapi_app/lib/core/git_forge_adapters.py's resolve_ref_to_sha() and
  // fastapi_app/lib/utils/annotation_rules_utils.py's fetch_rule_excerpt())
  // made directly inside an async route handler - they block the whole
  // event loop for their full duration (up to ~40s combined timeout) rather
  // than running in a thread pool. Combined with CI's always-cold
  // UrlCache (data_root is ephemeral per container run, so there's no
  // warm cache to short-circuit the network round trip) and GitHub's
  // unauthenticated 60 req/hour rate limit on shared Actions runner IPs,
  // this reliably exceeds Playwright's assertion timeouts under CI load
  // even though the underlying refresh eventually succeeds. Run manually
  // with `--grep "refreshes document rules on a legacy-style fixture"`
  // when validating this path locally.
  test.skip('refreshes document rules on a legacy-style fixture (appInfo but no editorialDecl) and reports success', async ({ page }) => {
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

  test('shows the headerbar indicator and decorates an overridden ref differently once an override is selected', async ({ page }) => {
    // Creating an override for the interpretation-ref resource resolves its
    // original text server-side regardless of whether the caller inspects
    // it (fastapi_app/routers/document_rules.py's create_override always
    // calls kind.resolve_original() before storing), so - like the
    // "refreshes document rules" test above - this test has an inherent
    // live dependency on GitHub (mpilhlt/fossil) even though it goes
    // through the API directly rather than the "Data correction" dialog.
    test.setTimeout(60000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    let overrideId = null;

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await loadFixtureDocument(page, 'document-rules-fixture');

      // No override selected yet: no headerbar indicator. The fixture's one
      // <ref target> lives inside editorialDecl, which tei-tools.js folds by
      // default (its own uiStorage 'teiHeaderVisible' preference defaults to
      // false) - unfold it directly via the xmleditor API (bypassing the
      // header-visibility toggle switch, so no preference is persisted) to
      // check the ref's un-overridden decoration state.
      // Scoped to the interpretation-ref's own URL text, not .first(): the
      // schema kind's <?xml-model href="..."> PI (in the fixture's prolog,
      // before <TEI>) is also decorated with .doc-rules-ref and always
      // visible regardless of teiHeader's fold state, so it would otherwise
      // be picked up instead of the ref this test actually exercises.
      await expect(page.locator('status-text[name="documentRulesOverridesStatus"]')).toHaveCount(0);
      await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').unfoldByXpath('//tei:teiHeader'));
      await page.waitForTimeout(300);
      const refSpan = page.locator(`#codemirror-container .cm-content .doc-rules-ref:has-text("${INTERPRETATION_REF_URL}")`);
      await expect(refSpan).toBeVisible();
      await expect(refSpan).not.toHaveClass(/doc-rules-ref-overridden/);

      // Re-fold so the headerbar indicator's click (checked below) is a
      // meaningful test of "reveals editorialDecl", not a no-op.
      await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').foldByXpath('//tei:teiHeader'));
      await page.waitForTimeout(300);

      // Create and select an override for the interpretation-ref resource
      // directly via the API rather than through the "Data correction"
      // dialog: opening that dialog also triggers the same live fetch (see
      // this test's header comment) with no added coverage, and stacking a
      // second dialog on top of it risks the pointer-interception issue the
      // "lists both resources..." test above already worked around by
      // deleting overrides directly rather than through a confirm dialog.
      overrideId = await page.evaluate(async (url) => {
        const client = /** @type {any} */ (window).client;
        const override = await client.apiClient.documentRulesOverrides({
          kind: 'interpretation-ref',
          fragment_url: url,
          note: '',
          text: 'Test override text.'
        });
        await client.apiClient.documentRulesSelection({
          kind: 'interpretation-ref',
          fragment_url: url,
          override_id: override.id
        });
        return override.id;
      }, INTERPRETATION_REF_URL);

      // Force the frontend to pick up the new selection: hovering
      // "Edit document rules" triggers _refreshResources() ->
      // _refreshOverrideIndicators(), the same trigger the "lists both
      // resources..." test above already relies on before reading the
      // submenu - neither of those calls resolves original text, so this
      // step itself adds no further network dependency.
      await openToolsMenu(page);
      const editMenuItem = page.locator('sl-menu-item:has-text("Edit document rules")');
      await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
      await editMenuItem.hover();
      await page.waitForTimeout(500);
      // Close the Tools dropdown (toggle) without clicking any menu item.
      await openToolsMenu(page);

      // Headerbar indicator now shows.
      const indicator = page.locator('status-text[name="documentRulesOverridesStatus"]');
      await expect(indicator).toBeVisible();

      // teiHeader is still folded: editorialDecl's tag name isn't in the
      // rendered main editor content yet.
      await expect(page.locator('#codemirror-container .cm-content')).not.toContainText('editorialDecl');

      // Clicking the indicator unfolds teiHeader and selects editorialDecl.
      await indicator.click();
      await page.waitForTimeout(500);
      await expect(page.locator('#codemirror-container .cm-content')).toContainText('editorialDecl');

      // The ref is now decorated as overridden.
      const refSpanAfter = page.locator(`#codemirror-container .cm-content .doc-rules-ref:has-text("${INTERPRETATION_REF_URL}")`);
      await expect(refSpanAfter).toHaveClass(/doc-rules-ref-overridden/);
    } finally {
      // Clean up the override created above (same rationale as the earlier
      // test in this file: no TTL/cascade-delete on resource_overrides).
      // Deleting it also cascades to clear the selection (see
      // fastapi_app/lib/doc_rules/storage.py's delete_override()), so the
      // headerbar indicator disappears again for the next run without a
      // separate reset call.
      if (overrideId) {
        await page.evaluate(async (id) => {
          await /** @type {any} */ (window).client.apiClient.documentRulesDeleteOverrides(id);
        }, overrideId);
      }
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });

  // These tests share port TWO_LAYER_PORT, the two-layer fixture document and its
  // override urls, so they must not run in parallel.
  test.describe('two-layer categories', () => {
    test.describe.configure({ mode: 'serial' });

    test('edits a human override and a machine override in separate tabs', async ({ page }) => {
      // The fixture's refs point at the local server of startRulesServer() (the
      // app server can't serve the files to itself: its async handlers fetch
      // synchronously).
      /** @type {http.Server | null} */
      let server = null;
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

      try {
        server = await startRulesServer(TWO_LAYER_PORT);

        await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
        await loadFixtureDocument(page, 'document-rules-two-layer-fixture');

        await openToolsMenu(page);
        const editMenuItem = page.locator('sl-menu-item:has-text("Edit document rules")');
        await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
        await editMenuItem.hover();
        await page.waitForTimeout(500);
        const submenu = page.locator('sl-menu-item:has-text("Edit document rules") sl-menu[slot="submenu"]');
        // One entry per rule category, not per layer.
        await expect(submenu.locator('sl-menu-item')).toHaveCount(2); // category + schema
        await submenu.locator('sl-menu-item:has-text("Data correction")').click();

        const dialog = page.locator('sl-dialog[name="documentRulesEditorDialog"]');
        await expect(dialog).toHaveAttribute('open', '');
        const humanTab = dialog.locator('sl-tab[name="humanLayerTab"]');
        const machineTab = dialog.locator('sl-tab[name="machineLayerTab"]');
        await expect(humanTab).toHaveText('Guide (human)');
        await expect(machineTab).toHaveText('Machine rules');

        const overrideRow = dialog.locator('[name="overrideRow"]');
        const originalBtn = overrideRow.locator('sl-button:has-text("Original")');
        const override1Btn = overrideRow.locator('sl-button:has-text("Override 1")');
        const mdContent = dialog.locator('[name="mdContainer"] .cm-content');

        // Human layer: create an override.
        await humanTab.click();
        await expect(originalBtn).toHaveAttribute('variant', 'primary');
        await expect(mdContent).toContainText('Human guide text');
        await dialog.locator('sl-button[name="newOverrideBtn"]').click();
        await expect(override1Btn).toHaveAttribute('variant', 'primary');

        // Machine layer: starts on "Original" despite the human override.
        await machineTab.click();
        await expect(mdContent).toContainText('Machine rule text');
        await expect(originalBtn).toHaveAttribute('variant', 'primary');
        await expect(override1Btn).toHaveCount(0);
        await dialog.locator('sl-button[name="newOverrideBtn"]').click();
        await expect(override1Btn).toHaveAttribute('variant', 'primary');

        // Close, reopen: each layer keeps its own selection.
        await dialog.locator('sl-button[name="closeBtn"]').click();
        await expect(dialog).not.toHaveAttribute('open', '');
        await openToolsMenu(page);
        await editMenuItem.hover();
        await page.waitForTimeout(500);
        await submenu.locator('sl-menu-item:has-text("Data correction")').click();
        await expect(dialog).toHaveAttribute('open', '');
        await humanTab.click();
        await expect(override1Btn).toHaveAttribute('variant', 'primary');
        await machineTab.click();
        await expect(override1Btn).toHaveAttribute('variant', 'primary');

        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        await deleteRuleOverrides(page, TWO_LAYER_RULE_URLS);
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });

    test('shows the sync status of a two-layer category', async ({ page }) => {
      // Same local markdown server as the previous test. machine.md carries
      // `<!-- sync: guide=... llm=... -->`; the hashes were computed with
      // fastapi_app.lib.doc_rules.guide_sync: `human_section_hash(<guide.md
      // "Data correction" section>, <guide url>)` and `section_hash(<machine.md
      // without the marker line>)`. Edit the fixtures and the hashes together.
      // The human url is not a forge url, so the synced-commit search returns null.
      /** @type {http.Server | null} */
      let server = null;
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

      try {
        server = await startRulesServer(TWO_LAYER_PORT);

        await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
        await loadFixtureDocument(page, 'document-rules-two-layer-fixture');

        await openToolsMenu(page);
        const editMenuItem = page.locator('sl-menu-item:has-text("Edit document rules")');
        await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
        await editMenuItem.hover();
        await page.waitForTimeout(500);
        const submenu = page.locator('sl-menu-item:has-text("Edit document rules") sl-menu[slot="submenu"]');
        await submenu.locator('sl-menu-item:has-text("Data correction")').click();

        const dialog = page.locator('sl-dialog[name="documentRulesEditorDialog"]');
        await expect(dialog).toHaveAttribute('open', '');
        const status = dialog.locator('[name="syncStatus"]');
        await expect(status).toBeVisible();
        await expect(status).toContainText('In sync with the guide');

        // A human override with changed text makes the machine rules outdated.
        await dialog.locator('sl-tab[name="humanLayerTab"]').click();
        await dialog.locator('sl-button[name="newOverrideBtn"]').click();
        const mdContent = dialog.locator('[name="mdContainer"] .cm-content');
        await mdContent.click();
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.type(' Changed.');
        await dialog.locator('sl-button[name="saveBtn"]').click();
        await expect(dialog.locator('sl-tab[name="humanLayerTab"]')).toBeVisible();
        await expect(status).toBeVisible();
        await expect(status).toContainText('Machine rules outdated: the guide changed since the last sync');

        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        await deleteRuleOverrides(page, TWO_LAYER_RULE_URLS);
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });

    test('proposes the guide section and the machine rules as a patch', async ({ page }) => {
      // The local rules server has no forge adapter, so the backend cannot build a real
      // proposal for localhost urls; propose-patch is mocked. The request body is checked.
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
      /** @type {http.Server | null} */
      let server = null;
      const patch = [
        '# Annotation rules update: Data correction',
        '# Proposed with the PDF-TEI-Editor by testreviewer',
        '# Includes: guide section and machine rules',
        'diff --git a/docs/guidelines.md b/docs/guidelines.md',
        '--- a/docs/guidelines.md',
        '+++ b/docs/guidelines.md',
        '@@ -1,3 +1,3 @@',
        ' # Data correction',
        ' ',
        '-Human guide text for data correction.',
        '+Human guide text for data correction. Changed.',
        'diff --git a/docs/guidelines-llm.md b/docs/guidelines-llm.md',
        '--- a/docs/guidelines-llm.md',
        '+++ b/docs/guidelines-llm.md',
        '@@ -1,5 +1,5 @@',
        ' # Data correction',
        ' ',
        '-<!-- sync: guide=aaaa llm=bbbb -->',
        '+<!-- sync: guide=cccc llm=dddd -->',
        ' ',
        ' Machine rule text.',
        ''
      ].join('\n');
      /** @type {any[]} */
      const requests = [];

      try {
        server = await startRulesServer(TWO_LAYER_PORT);
        await page.route('**/api/v1/document-rules/propose-patch', (route) => {
          requests.push(route.request().postDataJSON());
          return route.fulfill({
            json: {
              files: [
                { path: 'docs/guidelines.md', before: '# Data correction\n\nHuman guide text for data correction.\n', after: '# Data correction\n\nHuman guide text for data correction. Changed.\n' },
                { path: 'docs/guidelines-llm.md', before: '# Data correction\n\nMachine rule text.\n', after: '# Data correction\n\nMachine rule text, changed.\n' }
              ],
              patch,
              filename: 'data-correction-rules.patch',
              branch: 'main',
              upstream_changed: [],
              in_sync: true,
              can_open_pull_request: false,
              pull_request_title: 'Annotation rules update: Data correction',
              pull_request_body: ''
            }
          });
        });

        const dialog = await openMachineTab(page);
        const mdContent = dialog.locator('[name="mdContainer"] .cm-content');
        // A machine override and a human override
        for (const tab of ['machineLayerTab', 'humanLayerTab']) {
          await dialog.locator(`sl-tab[name="${tab}"]`).click();
          await dialog.locator('sl-button[name="newOverrideBtn"]').click();
          await mdContent.click();
          await page.keyboard.press('ControlOrMeta+End');
          await page.keyboard.type(' Changed.');
          await dialog.locator('sl-button[name="saveBtn"]').click();
          await expect(dialog.locator('[name="overrideRow"] sl-button:has-text("Override 1")')).toHaveAttribute('variant', 'primary');
        }

        await dialog.locator('sl-button[name="proposeUpstreamBtn"]').click();
        const proposeDialog = page.locator('sl-dialog[name="documentRulesProposeDialog"]');
        await expect(proposeDialog).toHaveAttribute('open', '');
        await expect(proposeDialog).toHaveAttribute('label', 'Propose upstream');
        await expect(proposeDialog.locator('sl-checkbox[name="includeHuman"]')).toHaveAttribute('checked', '');
        await expect(proposeDialog.locator('sl-checkbox[name="includeMachine"]')).toHaveAttribute('checked', '');
        await expect(proposeDialog.locator('[data-role="path"]')).toHaveText(['docs/guidelines.md', 'docs/guidelines-llm.md']);
        await expect(proposeDialog).toContainText('The sync marker is updated: the machine rules are marked as in sync with the guide.');
        expect(requests.at(-1)).toMatchObject({ include_human: true, include_machine: true, label: 'Data correction' });

        const downloadBtn = proposeDialog.locator('sl-button[name="downloadBtn"]');
        await expect(downloadBtn).toBeEnabled();
        const [download] = await Promise.all([page.waitForEvent('download'), downloadBtn.click()]);
        expect(download.suggestedFilename()).toBe('data-correction-rules.patch');
        const downloaded = readFileSync(/** @type {string} */ (await download.path()), 'utf8');
        expect(downloaded.match(/^diff --git a\//gm)).toHaveLength(2);
        expect(downloaded).toMatch(/<!-- sync: guide=\w+ llm=\w+ -->/);
        expect(downloaded).not.toContain('base=');

        await proposeDialog.locator('sl-button[name="closeBtn"]').click();
        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        await deleteRuleOverrides(page, TWO_LAYER_RULE_URLS);
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });

    test('creates a pull request from the propose dialog', async ({ page }) => {
      // No real GitHub call is possible in E2E: propose-patch and propose-pull-request are
      // mocked. The request body of the latter is checked.
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
      /** @type {http.Server | null} */
      let server = null;
      /** @type {any[]} */
      const prRequests = [];

      try {
        server = await startRulesServer(TWO_LAYER_PORT);
        await page.route('**/api/v1/document-rules/propose-patch', (route) => route.fulfill({
          json: {
            files: [
              { path: 'docs/guidelines.md', before: '# Data correction\n\nHuman guide text for data correction.\n', after: '# Data correction\n\nHuman guide text for data correction. Changed.\n' },
              { path: 'docs/guidelines-llm.md', before: '# Data correction\n\nMachine rule text.\n', after: '# Data correction\n\nMachine rule text, changed.\n' }
            ],
            patch: 'diff --git a/docs/guidelines.md b/docs/guidelines.md\n',
            filename: 'data-correction-rules.patch',
            branch: 'main',
            upstream_changed: [],
            in_sync: true,
            can_open_pull_request: true,
            pull_request_title: 'Annotation rules update: Data correction',
            pull_request_body: 'Proposed with the PDF-TEI-Editor by testreviewer.\n\nIncludes: guide section and machine rules.\nThe sync marker of the machine rules is updated; the pair is in sync.'
          }
        }));
        await page.route('**/api/v1/document-rules/propose-pull-request', (route) => {
          prRequests.push(route.request().postDataJSON());
          return route.fulfill({
            json: { url: 'https://github.com/example/guides/pull/42', number: 42, branch: 'pdf-tei-editor/data-correction-20261028-120000', fork: 'testreviewer/guides' }
          });
        });

        const dialog = await openMachineTab(page);
        const mdContent = dialog.locator('[name="mdContainer"] .cm-content');
        for (const tab of ['machineLayerTab', 'humanLayerTab']) {
          await dialog.locator(`sl-tab[name="${tab}"]`).click();
          await dialog.locator('sl-button[name="newOverrideBtn"]').click();
          await mdContent.click();
          await page.keyboard.press('ControlOrMeta+End');
          await page.keyboard.type(' Changed.');
          await dialog.locator('sl-button[name="saveBtn"]').click();
          await expect(dialog.locator('[name="overrideRow"] sl-button:has-text("Override 1")')).toHaveAttribute('variant', 'primary');
        }

        await dialog.locator('sl-button[name="proposeUpstreamBtn"]').click();
        const proposeDialog = page.locator('sl-dialog[name="documentRulesProposeDialog"]');
        await expect(proposeDialog).toHaveAttribute('open', '');
        const title = proposeDialog.locator('sl-input[name="prTitle"]');
        await expect(title.locator('input')).toHaveValue('Annotation rules update: Data correction');
        await expect(proposeDialog.locator('sl-textarea[name="prBody"] textarea')).toHaveValue(/Includes: guide section and machine rules\./);
        const createBtn = proposeDialog.locator('sl-button[name="createPrBtn"]');
        await expect(createBtn).toBeEnabled();

        await title.locator('input').fill('Edited title');
        await createBtn.click();

        const result = proposeDialog.locator('[name="prResult"]');
        await expect(result).toContainText('Pull request #42 created.');
        await expect(result).toContainText('It was opened from your fork testreviewer/guides.');
        await expect(result.locator('a')).toHaveAttribute('href', 'https://github.com/example/guides/pull/42');
        await expect(result.locator('a')).toHaveText('Open on GitHub');
        expect(prRequests).toHaveLength(1);
        expect(prRequests[0]).toMatchObject({ include_human: true, include_machine: true, label: 'Data correction', title: 'Edited title' });
        await expect(createBtn).toHaveAttribute('disabled', '');

        await proposeDialog.locator('sl-button[name="closeBtn"]').click();
        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        await deleteRuleOverrides(page, TWO_LAYER_RULE_URLS);
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });

    test('updates the machine rules from the guide', async ({ page }) => {
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
      /** @type {http.Server | null} */
      let server = null;

      try {
        server = await startRulesServer(TWO_LAYER_PORT);
        await mockLlm(page, [{ id: 'mock', label: 'Mock provider', models: [{ id: 'mock-model', label: 'Mock model' }] }]);
        await page.route('**/api/v1/document-rules/update-from-guide', (route) => route.fulfill({
          json: { mode: 'align', old_human: null, new_human: 'Human guide text for data correction.', machine: 'Machine rule text.', proposed: PROPOSED_MACHINE_TEXT, unchanged: false }
        }));

        const dialog = await openMachineTab(page);
        await dialog.locator('sl-button[name="updateFromGuideBtn"]').click();
        const updateDialog = page.locator('sl-dialog[name="documentRulesUpdateDialog"]');
        await expect(updateDialog).toHaveAttribute('open', '');
        await expect(updateDialog).toContainText('Change in the guide');
        await expect(updateDialog).toContainText('No sync base found');
        await updateDialog.locator('sl-button[name="generateBtn"]').click();
        await expect(updateDialog).toContainText('Proposed machine rules');
        await updateDialog.locator('sl-button[name="acceptBtn"]').click();
        await expect(updateDialog).not.toHaveAttribute('open', '');

        const overrideRow = dialog.locator('[name="overrideRow"]');
        await expect(overrideRow.locator('sl-button:has-text("Override 1")')).toHaveAttribute('variant', 'primary');
        await expect(dialog.locator('[name="mdContainer"] .cm-content')).toContainText('Proposed machine rule text.');
        const stored = await page.evaluate(async (url) => {
          const query = await /** @type {any} */ (window).client.apiClient.documentRulesQuery({ kind: 'interpretation-ref', url });
          return query.overrides.map((o) => ({ text: o.text, note: o.note }));
        }, TWO_LAYER_RULE_URLS[1]);
        expect(stored).toEqual([{ text: PROPOSED_MACHINE_TEXT, note: 'Updated from guide with Mock provider/Mock model' }]);

        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        await deleteRuleOverrides(page, TWO_LAYER_RULE_URLS);
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });

    test('asks for a missing API key on top of the update dialog', async ({ page }) => {
      const consoleLogs = setupTestConsoleCapture(page);
      // the mocked 428 below is logged by the browser
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, [...ALLOWED_ERROR_PATTERNS, 'Failed to load resource.*428']);
      /** @type {http.Server | null} */
      let server = null;

      try {
        server = await startRulesServer(TWO_LAYER_PORT);
        await mockLlm(page, [{ id: 'mock', label: 'Mock provider', models: [{ id: 'mock-model', label: 'Mock model' }] }]);
        // test-secret-service is registered by the test plugin (tests/fixtures/plugins/test_plugin/)
        await page.route('**/api/v1/document-rules/update-from-guide', (route) => route.fulfill({
          status: 428,
          json: { detail: { code: 'secret_required', message: 'Test Service needs your API key', service: 'test-secret-service', label: 'Test Service', description: '', help_url: '' } }
        }));

        const dialog = await openMachineTab(page);
        await dialog.locator('sl-button[name="updateFromGuideBtn"]').click();
        const updateDialog = page.locator('sl-dialog[name="documentRulesUpdateDialog"]');
        await expect(updateDialog).toHaveAttribute('open', '');
        await page.waitForTimeout(500);
        await updateDialog.locator('sl-button[name="generateBtn"]').click();

        const keyDialog = page.locator('sl-dialog[name="apiKeysDialog"]');
        await expect(keyDialog).toHaveAttribute('open', '');
        const keyInput = keyDialog.locator('sl-input[label="Test Service"]');
        await expect(keyInput).toBeVisible();
        await page.waitForTimeout(500);
        // The topmost element at the input's center belongs to the key dialog, not the update dialog
        const onTop = await keyInput.evaluate((input) => {
          const rect = input.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit !== null && /** @type {Element} */ (input.closest('sl-dialog')).contains(hit);
        });
        expect(onTop).toBe(true);
        await keyInput.click({ timeout: 5000 });

        await keyDialog.locator('sl-button[name="closeBtn"]').click();
        await expect(keyDialog).not.toHaveAttribute('open', '');
        await updateDialog.locator('sl-button[name="closeBtn"]').click();
        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });

    test('tells the user when no language model is available for updating from the guide', async ({ page }) => {
      const consoleLogs = setupTestConsoleCapture(page);
      const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
      /** @type {http.Server | null} */
      let server = null;

      try {
        server = await startRulesServer(TWO_LAYER_PORT);
        await mockLlm(page, []);

        const dialog = await openMachineTab(page);
        await dialog.locator('sl-button[name="updateFromGuideBtn"]').click();
        const updateDialog = page.locator('sl-dialog[name="documentRulesUpdateDialog"]');
        await expect(updateDialog).toHaveAttribute('open', '');
        await expect(updateDialog).toContainText('No language model is available. Update the machine rules by hand, using the change shown above.');
        await expect(updateDialog.locator('[name="modelRow"]')).toBeHidden();

        await updateDialog.locator('sl-button[name="closeBtn"]').click();
        await dialog.locator('sl-button[name="closeBtn"]').click();
      } finally {
        server?.close();
        stopErrorMonitoring();
        await releaseAllLocks(page);
      }
    });
  });
});

/**
 * TEI Header Editor E2E tests
 *
 * Covers the teiHeader editor dialog's happy-path save/reload round-trip
 * (editing fileDesc/publicationStmt/publisher as a reviewer) and the
 * pure-annotator role gate (the toolbar button is hidden entirely for
 * annotator-only users - see acl-utils.js's userIsAnnotatorOnly()).
 *
 * Writing this test uncovered four real, previously-untested bugs in the
 * "fully implemented" feature (none of this was caught by unit tests,
 * since none of them exercised the real bundled core TEI schema end to
 * end):
 *
 * 1. `app/src/ui.js` never imported `SlDetails`
 *    (`@shoelace-style/shoelace/dist/components/details/details.js`), so
 *    every `<sl-details>` TeiHeaderEditorPlugin creates was an inert,
 *    unregistered custom element: no shadow DOM, no rendered summary
 *    header text, no collapse/expand behavior at all. Fixed by adding the
 *    import (same pattern as every other Shoelace component there).
 * 2. `fastapi_app/lib/utils/relaxng_to_codemirror.py`'s
 *    `extract_tag_definitions()` re-walked the schema's cross-referenced
 *    pattern graph from scratch per ATTRIBUTE per element
 *    (`_is_attribute_required()`/`_find_attribute_elements()`) instead of
 *    once per element - the same anti-pattern a prior perf pass already
 *    fixed for child elements - without per-tag memoization across a BFS's
 *    repeated visits to shared vocabulary elements. A cold call to
 *    POST /validate/teiheader-structure measured ~33s before these fixes
 *    (plus a `_tag_definition_cache`), ~1.6s after.
 * 3. `app/src/modules/tei-header-form.js`'s `buildNode()` used a
 *    per-branch ancestor set for cycle detection, which only catches a tag
 *    reappearing in its own descendant chain - not the same shared tag
 *    (e.g. `p`, `date`, `idno`) being reachable as a child of many
 *    different parents, which is the common case in a real TEI schema.
 *    Every such occurrence re-expanded its own full subtree independently,
 *    which is combinatorial and never terminated in testing against the
 *    bundled core schema (233k+ DOM elements, browser tab crashes under
 *    long waits). Fixed by expanding each tag's subtree at most once
 *    globally (see that function's docstring) - but even with that fix,
 *    the schema's default MAX_DEPTH of 6 (per the design spec) still
 *    produces an impractically large tree (~1000+ fields, 50k+ DOM
 *    elements) for a document with no declared schema (falls back to the
 *    full bundled core schema - see validation.py's
 *    `resolve_document_schema_cache_file()`), which is this fixture
 *    document's situation and plausibly a common real-world one. MAX_DEPTH
 *    was reduced to 2 here as a pragmatic stopgap to keep the dialog
 *    responsive; a proper fix (e.g. lazy/on-demand expansion, or curating
 *    which tags are worth exposing) is a separate, larger follow-up this
 *    test does not attempt.
 * 4. `publisher` (like most of publicationStmt's children - date, idno,
 *    pubPlace, availability, distributor, authority, address - per the
 *    bundled core schema) is NOT a schema leaf: TEI's `<publisher>` may
 *    contain structured markup (e.g. `orgName`), so the renderer's binary
 *    leaf/non-leaf decision (`children.length === 0`) renders it as its
 *    own collapsible `sl-details`, not a plain `sl-input` - unlike the
 *    design spec's sketch, which assumed a plain-text leaf. This also
 *    means the fixture's existing `<publisher>Nomos Verlag</publisher>`
 *    (plain text, no child elements) is not editable as such through this
 *    dialog at all - the spec's own documented v1 limitation ("any element
 *    whose content model mixes text and element children... falls back to
 *    a single read/write sl-textarea of its raw inner XML") describes
 *    exactly this case but does not appear to be implemented; confirming
 *    that gap is left to a follow-up. This test instead drills one level
 *    into `publisher` and edits `orgName` (a true leaf at this MAX_DEPTH),
 *    which exercises the identical save/reload mechanics.
 *
 * @testCovers app/src/plugins/tei-header-editor.js
 * @testCovers app/src/modules/tei-header-form.js
 * @testCovers app/src/modules/acl-utils.js
 * @testCovers app/src/ui.js
 * @testCovers fastapi_app/routers/validation.py
 * @testCovers fastapi_app/lib/utils/relaxng_to_codemirror.py
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
 * Finds the one `sl-details` directly under `containerSelector` whose
 * `summary` JS property is exactly `tag`, and tags it with a unique
 * `data-e2e-marker` attribute so the caller can build an exact, stable
 * Playwright locator for it.
 *
 * `summary` is set via TeiHeaderEditorPlugin#renderSection() as a plain
 * (non-reflecting) Shoelace property - it never becomes a `summary="..."`
 * DOM attribute, so `sl-details[summary=...]` never matches anything.
 * Matching on rendered text (`hasText`) is also unreliable here: a
 * collapsed `sl-details`' descendants are still present in the DOM (just
 * CSS-hidden), so `hasText: 'publisher'` also matches unrelated siblings
 * whose own collapsed, deeply-nested subtree happens to contain another
 * "publisher" occurrence (a real risk at this schema's scale - see this
 * file's header comment). Matching on the exact `summary` property value
 * sidesteps both problems.
 * @param {import('@playwright/test').Page} page
 * @param {string} containerSelector
 * @param {string} tag
 * @param {string} marker
 */
async function markDetailsByTag(page, containerSelector, tag, marker) {
  const found = await page.evaluate(({ containerSelector, tag, marker }) => {
    const container = document.querySelector(containerSelector);
    const match = [...container.children].find((el) => el.tagName === 'SL-DETAILS' && el.summary === tag);
    if (match) match.setAttribute('data-e2e-marker', marker);
    return !!match;
  }, { containerSelector, tag, marker });
  expect(found, `no direct sl-details child of "${containerSelector}" with summary "${tag}"`).toBe(true);
}

/**
 * Opens the teiHeader editor dialog for the currently loaded document,
 * expands the publicationStmt section and then its publisher subsection
 * (both render as `sl-details`, collapsed by default - see this file's
 * header comment on why `publisher` itself is non-leaf).
 * @param {import('@playwright/test').Page} page
 * @param {number} [dialogTimeout] longer-than-default timeout to absorb the
 *   first POST /validate/teiheader-structure call's cache warm-up cost
 *   (see this file's header comment)
 * @returns {Promise<import('@playwright/test').Locator>} the expanded
 *   publisher `sl-details` locator, so callers can scope further field
 *   lookups to it - `orgName` is not unique dialog-wide
 */
async function openHeaderEditorAndExpandPublisher(page, dialogTimeout) {
  await page.click('[name="headerEditorBtn"]');
  const dialog = page.locator('sl-dialog[name="teiHeaderEditorDialog"]');
  await expect(dialog).toBeVisible(dialogTimeout ? { timeout: dialogTimeout } : undefined);
  await page.waitForTimeout(500); // Shoelace dialog animation, per tests/CLAUDE.md

  await markDetailsByTag(page, '[name="sectionsContainer"]', 'publicationStmt', 'e2e-publicationStmt');
  const publicationStmtDetails = dialog.locator('[data-e2e-marker="e2e-publicationStmt"]');
  await expect(publicationStmtDetails).toBeVisible();
  await publicationStmtDetails.click();
  await page.waitForTimeout(500); // sl-details expand animation
  await expect(publicationStmtDetails).toHaveAttribute('open', '');

  // publisher is itself non-leaf (see header comment) - expand it too.
  await markDetailsByTag(page, '[data-e2e-marker="e2e-publicationStmt"]', 'publisher', 'e2e-publisher');
  const publisherDetails = dialog.locator('[data-e2e-marker="e2e-publisher"]');
  await expect(publisherDetails).toBeVisible();
  await publisherDetails.click();
  await page.waitForTimeout(500); // sl-details expand animation
  await expect(publisherDetails).toHaveAttribute('open', '');
  return publisherDetails;
}

test.describe('TEI Header Editor', () => {
  test('reviewer can open the dialog, edit publisher/orgName, and see it persisted after reload', async ({ page }) => {
    // Exceeds Playwright's 30s default comfortably: login, PDF/XML fixture
    // loading, a page reload and two dialog round-trips all add up, even
    // though no single step is slow on its own.
    test.setTimeout(120000);

    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // The standard E2E fixture set ships exactly one PDF/gold pair
      // (10.5771__2699-1284-2024-3-149), whose fileDesc already has a
      // publicationStmt/publisher ("Nomos Verlag") - a reasonable existing
      // fixture rather than one created just for this test.
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

      const publisherDetails = await openHeaderEditorAndExpandPublisher(page, 15000);

      // Scoped to the expanded publisher section: `orgName` is not unique
      // dialog-wide (it's a widely-reused TEI name element). `.fill()`
      // targets a real `<input>`/`<textarea>`, not the `sl-input` custom
      // element itself - reach into its shadow DOM the same way
      // docker-infrastructure.spec.js's login fields do.
      const orgNameInput = publisherDetails.locator('sl-input[data-tag="orgName"]');
      await expect(orgNameInput).toBeVisible();
      await orgNameInput.locator('input').fill('Test Publisher E2E');

      // At this schema's scale (see this file's header comment on
      // MAX_DEPTH), the core schema's cardinality data marks fields
      // required unconditionally - even deep inside bibliographic
      // structures (e.g. biblStruct's `monogr`) that this fixture document
      // doesn't use at all - so TeiHeaderEditorPlugin#onSave() blocks the
      // save until every such field has SOME value, regardless of whether
      // its containing section is otherwise empty. Fill every currently-
      // empty required field (not just the one(s) under test) so save can
      // proceed - this mirrors what a real user would have to do today,
      // not a workaround specific to this test.
      // NCName-safe (no spaces/colons): some required fields are typed
      // attributes like `xml:id`, which the backend's XML validation
      // rejects outright if the value isn't a valid NCName.
      await page.evaluate(() => {
        const dialog = document.querySelector('sl-dialog[name="teiHeaderEditorDialog"]');
        for (const el of dialog.querySelectorAll('sl-input[required], sl-textarea[required]')) {
          if (!el.value) el.value = 'e2e_placeholder';
        }
      });

      // Scoped to this dialog and to the `sl-button` tag specifically:
      // `name="saveBtn"` is reused by several other dialogs in the app
      // (document-rules-editor-dialog, rbac-manager-dialog,
      // user-profile-dialog), so an unscoped `page.click('[name="saveBtn"]')`
      // resolves to several elements dialog-wide; `sl-button` reflects
      // `name` onto its own internal native `<button>` too, so an
      // attribute-only selector matches both host and shadow button.
      const dialog = page.locator('sl-dialog[name="teiHeaderEditorDialog"]');
      await dialog.locator('sl-button[name="saveBtn"]').click();
      // Longer than the usual 500ms Shoelace-dialog-animation wait: saving
      // re-serializes the whole (large, see MAX_DEPTH note above) field
      // tree back into the XML document before the dialog hides.
      await expect(dialog).not.toBeVisible({ timeout: 20000 });

      // Reload: the app restores both the authenticated session (server-side
      // session check in AuthenticationPlugin#ensureAuthenticated()) and the
      // previously loaded pdf/xml pair (sessionStorage-persisted state, see
      // state-manager.js) without re-navigating through login or the file
      // selectboxes.
      await page.reload();
      await page.waitForSelector('#codemirror-container .cm-editor');
      await page.waitForFunction(() => {
        const app = /** @type {any} */ (window).app;
        const xmlEditor = app && app.getDependency('xmleditor');
        const view = xmlEditor && xmlEditor.getView();
        return view && view.state.doc.length > 0;
      }, { timeout: 15000 });
      await page.waitForTimeout(500);

      // The backend's core-defs cache is warm from the first open above
      // (same server process survives the frontend reload), so the POST
      // /validate/teiheader-structure call itself is fast this time - but
      // the frontend's own field-tree build + ~50k-element DOM render (see
      // this file's header comment on MAX_DEPTH) is NOT cached and happens
      // fresh on every open, so this still needs the extended timeout.
      const publisherDetailsAfterReload = await openHeaderEditorAndExpandPublisher(page, 15000);
      await expect(publisherDetailsAfterReload.locator('sl-input[data-tag="orgName"] input')).toHaveValue('Test Publisher E2E');
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

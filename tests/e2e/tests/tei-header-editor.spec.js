/**
 * TEI Header Editor E2E tests
 *
 * Covers the teiHeader editor dialog's happy-path save/reload round-trip
 * (editing fileDesc/publicationStmt/publisher as a reviewer) and the
 * pure-annotator role gate (the toolbar button is hidden entirely for
 * annotator-only users - see acl-utils.js's userIsAnnotatorOnly()).
 *
 * Writing this test against the real bundled core TEI schema (no
 * document schema declared, the common case) surfaced several real bugs
 * - a missing SlDetails registration, a backend perf anti-pattern, an
 * unbounded field-tree expansion, invalid XML from empty attributes, and
 * (in a later commit) silent data loss for plain-text non-leaf elements -
 * see the `770207bb`/`fc51c63d` commit messages for the full
 * investigation and fixes; this header only tracks what's still open.
 *
 * `publisher` (like most of publicationStmt's children) is schema
 * non-leaf, so the fixture's existing plain-text
 * `<publisher>Nomos Verlag</publisher>` isn't editable as such through
 * this dialog - the design spec's own documented v1 limitation (mixed
 * text/element content falls back to a raw-XML textarea) doesn't appear
 * to be implemented. This test drills one level into `publisher` and
 * edits `orgName` instead, which exercises the same save/reload
 * mechanics. That gap (full mixed-content editing) is a follow-up; the
 * data-loss consequence of it is fixed (see `fc51c63d`).
 *
 * `tei-header-form.js`'s `MAX_DEPTH` is reduced from the design spec's 6
 * to 2 (see that constant's docstring) - the real schema's cross-
 * referenced vocabulary makes depth 6 impractically large even with the
 * global-expand-once fix. A proper fix (lazy expansion, or curating
 * exposed tags) is a separate follow-up.
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

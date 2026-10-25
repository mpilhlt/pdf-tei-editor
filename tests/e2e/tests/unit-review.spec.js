/**
 * Unit review end-to-end tests
 *
 * Switches on review mode for an editable copy of a document whose <text> holds three
 * <bibl> units, marks them with the keyboard, the comment prompt and the review popover,
 * checks the stand-off storage, the status bar meter, the diagnostics and undo, the
 * carry-over of marks of an edited unit, and the "Clear reviews" option of the Save Revision
 * dialog, the automatic review mode for documents with not-OK units, and the reload of a
 * read-only document after another user saved it, and the keyboard shortcuts in visual mode.
 *
 * @testCovers app/src/plugins/unit-review.js
 * @testCovers app/src/modules/unit-review.js
 * @testCovers app/src/modules/unit-review-popover.js
 * @testCovers app/src/modules/codemirror/unit-review-gutter.js
 * @testCovers app/src/plugins/document-actions.js
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/unit-comments.js
 * @testCovers app/src/plugins/xml-annotation.js
 * @testCovers app/src/templates/save-document-dialog.html
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure, waitForTestMessage } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

const TEXT = `<text>
    <listBibl>
      <bibl>Alpha 2001</bibl>
      <bibl>Beta 2002</bibl>
      <bibl>Gamma 2003</bibl>
    </listBibl>
  </text>`;

const STAND_OFF = `<standOff>
    <listAnnotation type="unit-review" subtype="fp-sha256-8-v1">
      <note type="unit-xpath">./listBibl/*</note>
    </listAnnotation>
  </standOff>`;

/**
 * Loads an editable copy of the first document with the test <text>.
 * @param {Page} page
 * @param {string} [standOff] - Inserted after the teiHeader
 * @param {string} [text] - The <text> element
 * @returns {Promise<string>} The stable id of the copy
 */
async function loadReviewDocument(page, standOff = '', text = TEXT) {
  const stableId = await page.evaluate(async ({ text, standOff }) => {
    const w = /** @type {any} */ (window);
    const xml = w.app.getDependency('xmleditor').getXML()
      .replace(/<standOff[\s\S]*?<\/standOff>\s*/, '')
      .replace(/<text[\s>][\s\S]*<\/text>/, text)
      .replace('</teiHeader>', `</teiHeader>${standOff}`);
    const res = await w.client.apiClient.filesSave({ xml_string: xml, file_id: 'unit-review-probe', new_version: true });
    await w.app.getDependency('services').load({ xml: res.file_id });
    return res.file_id;
  }, { text, standOff });
  await page.waitForFunction((expectedXml) => {
    const app = /** @type {any} */ (window).app;
    return app.getCurrentState().xml === expectedXml && app.getCurrentState().editorReadOnly === false;
  }, stableId, { timeout: 20000 });
  return stableId;
}

/**
 * @param {Page} page
 * @returns {Promise<string>}
 */
async function editorText(page) {
  return page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').getView().state.doc.toString());
}

/**
 * Puts the cursor on the line containing the given text.
 * @param {Page} page
 * @param {string} needle
 * @returns {Promise<number>} The 1-based line number
 */
async function cursorTo(page, needle) {
  return page.evaluate((needle) => {
    const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
    const pos = view.state.doc.toString().indexOf(needle);
    if (pos === -1) throw new Error(`"${needle}" not in document`);
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    return view.state.doc.lineAt(pos).number;
  }, needle);
}

/**
 * @param {Page} page
 * @returns {Promise<{units: number, ok: number, notOk: number, disputed: number, open: number}>}
 */
async function summary(page) {
  return page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review').getSummary());
}

test.describe('Unit review', () => {

  test('marks units, stores them stand-off and clears them in a new version', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadReviewDocument(page);

      // review mode: toolbar toggle shows the strip and the meter
      await page.locator('[name="unitReviewToggle"]').click();
      await waitForTestMessage(consoleLogs, 'UNIT_REVIEW_MODE');
      await expect(page.locator('.cm-unit-review-gutter')).toBeVisible();
      await expect(page.getByTestId('unit-review-meter')).toContainText('0 OK · 0 not OK · 3 open');

      // Mod-Enter marks the unit OK and moves to the next one
      await cursorTo(page, 'Alpha');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 0 not OK · 2 open');
      let text = await editorText(page);
      expect(text).toMatch(/<standOff>\s*<listAnnotation type="unit-review" subtype="fp-sha256-8-v1">/);
      expect(text).toContain('<note type="unit-xpath">');
      expect(text).toMatch(/<annotation xml:id="ur-testreviewer" motivation="assessing" target="#xpath\(\/\/text\)" resp="#testreviewer">/);
      expect(text).toMatch(/<respStmt>\s*<persName xml:id="testreviewer">/);
      // the marks are inserted above the units, so compare with the current line of the next unit
      const lines = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        return {
          cursor: view.state.doc.lineAt(view.state.selection.main.head).number,
          beta: view.state.doc.lineAt(view.state.doc.toString().indexOf('Beta')).number
        };
      });
      expect(lines.cursor).toBe(lines.beta);
      await expect(page.locator('.cm-ur-ok')).toHaveCount(1);

      // the new standOff is folded; a manual unfold lasts until the header is folded
      const content = page.locator('#codemirror-container .cm-content');
      await expect(content).not.toContainText('unit-xpath');
      await expect.poll(() => page.evaluate(() => {
        const xmleditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        // unfoldByXpath works on the DOM tree, which is synced with a delay after edits
        if (!xmleditor.getXmlTree()?.querySelector('standOff > listAnnotation')) return false;
        try { xmleditor.unfoldByXpath('/tei:TEI/tei:standOff'); } catch { return false; }
        return !xmleditor.isFoldedByXpath('/tei:TEI/tei:standOff');
      })).toBe(true);
      await expect(content).toContainText('unit-xpath');
      const headerToggle = page.locator('[name="headerFoldToggle"]');
      await headerToggle.click();
      await headerToggle.click();
      await expect(content).not.toContainText('unit-xpath');

      // typing inside the standOff is rejected for non-admins
      const typed = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const before = view.state.doc.toString();
        const pos = before.indexOf('<note type="summary">') + '<note type="summary">'.length;
        view.dispatch({ changes: { from: pos, insert: 'x' }, userEvent: 'input.type' });
        return view.state.doc.toString() === before;
      });
      expect(typed).toBe(true);

      // Mod-Shift-Enter marks it not OK and asks for a comment
      await cursorTo(page, 'Beta');
      await page.keyboard.press('ControlOrMeta+Shift+Enter');
      const prompt = page.getByTestId('unit-review-comment-prompt');
      await expect(prompt).toBeVisible();
      await prompt.locator('input').fill('wrong year');
      await prompt.locator('input').press('Enter');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 1 not OK · 1 open');
      text = await editorText(page);
      const betaFp = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review').getUnits()[1].fingerprint);
      expect(text).toContain(`<note type="not-ok" n="${betaFp}">wrong year</note>`);
      expect(text).toContain('<note type="summary">units=3 ok=1 not-ok=1 disputed=0 open=1</note>');

      // the not-OK unit is listed as a diagnostic
      await expect.poll(async () => page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        const view = app.getDependency('xmleditor').getView();
        return app.getDependency('lint-utils').collectDiagnostics(view.state)
          .filter((/** @type {any} */ d) => d.source === 'unit-review').map((/** @type {any} */ d) => d.message);
      })).toEqual([expect.stringContaining('wrong year')]);

      // hovering the unit shows no lint tooltip: the context menu row has the review buttons
      const betaHover = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Beta') + 2);
        return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.move(betaHover.x, betaHover.y);
      await page.waitForTimeout(800);
      await expect(page.locator('.cm-tooltip-lint')).toHaveCount(0);

      // the drawer's actions open the review and mark the unit
      const drawerItem = page.locator('.diagnostics-drawer-item', { hasText: 'wrong year' });
      await drawerItem.locator('.diagnostics-drawer-action', { hasText: 'Open review' }).click();
      await expect(page.getByTestId('unit-review-popover')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('unit-review-popover')).toHaveCount(0);
      await drawerItem.locator('.diagnostics-drawer-action', { hasText: 'OK' }).first().click();
      await expect(page.getByTestId('unit-review-meter')).toContainText('2 OK · 0 not OK · 1 open');
      await cursorTo(page, 'Gamma');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 1 not OK · 1 open');

      // a click on the strip opens the popover; mark the third unit OK there
      await cursorTo(page, 'Gamma');
      const point = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Gamma'));
        const gutter = view.dom.querySelector('.cm-unit-review-gutter').getBoundingClientRect();
        return { x: gutter.left + gutter.width / 2, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(point.x, point.y);
      const popover = page.getByTestId('unit-review-popover');
      await expect(popover).toBeVisible();
      await popover.locator('button[data-state="ok"]').click();
      await popover.getByTestId('unit-review-save').click();
      await expect(popover).toHaveCount(0);
      await expect(page.getByTestId('unit-review-meter')).toContainText('2 OK · 1 not OK · 0 open');

      // undo removes the last mark
      await cursorTo(page, 'Gamma');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 1 not OK · 1 open');

      // the context menu row marks the right-clicked unit, not the one at the cursor
      await cursorTo(page, 'Alpha');
      const gammaPoint = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Gamma') + 2);
        return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(gammaPoint.x, gammaPoint.y, { button: 'right' });
      const menuRow = page.getByTestId('unit-review-menu-row');
      await expect(menuRow).toBeVisible();
      await expect(menuRow.getByTestId('unit-review-menu-patch-check')).toBeHidden();
      await menuRow.getByTestId('unit-review-menu-check-lg').click();
      await expect(menuRow).toBeHidden();
      await expect(page.getByTestId('unit-review-meter')).toContainText('2 OK · 1 not OK · 0 open');
      await cursorTo(page, 'Gamma');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 1 not OK · 1 open');

      // editing a reviewed unit keeps its marks as was- marks: the unit is stale
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const pos = view.state.doc.toString().indexOf('Alpha 2001') + 'Alpha '.length;
        view.dispatch({ changes: { from: pos, to: pos + 4, insert: '2011' } });
      });
      await expect.poll(async () => editorText(page)).toMatch(/<note type="was-ok">[0-9a-f]{8}<\/note>/);
      expect((await summary(page)).ok).toBe(0);
      await expect(page.locator('.cm-ur-stale')).toHaveCount(1);

      // setting "approved" with open reviews asks for confirmation; cancelling saves nothing
      const dialog = page.locator('sl-dialog[name="saveDocumentDialog"]');
      await page.locator('sl-button[name="saveRevision"]').click();
      await expect(dialog).toHaveAttribute('open', '');
      await dialog.locator('sl-select[name="status"]').evaluate((/** @type {any} */ el) => { el.value = 'approved'; });
      await dialog.locator('sl-button[name="submit"]').click();
      await waitForTestMessage(consoleLogs, 'UNIT_REVIEW_APPROVAL_WARNING');
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await expect(confirmDialog).toContainText('1 not OK, 2 not reviewed');
      await confirmDialog.locator('sl-button[name="cancelBtn"]').click();
      await expect(confirmDialog).not.toHaveAttribute('open', '');
      expect(await editorText(page)).not.toContain('status="approved"');

      // "Clear reviews" in the Save Revision dialog removes the marks from the new version
      await page.locator('sl-button[name="saveRevision"]').click();
      await expect(dialog).toHaveAttribute('open', '');
      const clearSection = dialog.locator('[name="clearReviewsSection"]');
      await expect(clearSection).toBeHidden();
      await dialog.locator('sl-checkbox[name="saveToNewCopy"]').click();
      await expect(clearSection).toBeVisible();
      await clearSection.locator('sl-checkbox[name="clearReviews"]').click();
      await dialog.locator('sl-input[name="changeDesc"] input').fill('Copy without reviews');
      await dialog.locator('sl-button[name="submit"]').click();
      await waitForTestMessage(consoleLogs, 'UNIT_REVIEWS_CLEARED');
      await waitForTestMessage(consoleLogs, 'NEW_VERSION_LOADED');
      await expect.poll(async () => editorText(page)).not.toContain('unit-review');
      expect(await editorText(page)).not.toContain('<standOff');
      await expect(page.getByTestId('unit-review-meter')).toContainText('0 OK · 0 not OK · 3 open');
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review')?.setEnabled(false)).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('opens documents with units marked not OK in review mode, showing annotators only the reviews', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const stableId = await loadReviewDocument(page, STAND_OFF);
      // a not-OK mark of the LLM Reviewer (an annotator's save keeps only their own and LLM marks)
      await page.evaluate(async () => {
        const app = (/** @type {any} */ (window)).app;
        const review = app.getDependency('unit-review');
        const unit = review.getUnits().find((/** @type {any} */ u) => u.name === 'bibl');
        await review.setMarks({ id: 'llm-probe', name: 'Probe LLM' }, [{ fingerprint: unit.fingerprint, state: 'not-ok', comment: 'Wrong year' }]);
        await review.setEnabled(false);
        await app.getDependency('xmleditor').saveIfDirty();
      });
      expect(await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review').isEnabled())).toBe(false);

      await page.evaluate(async (xml) => (/** @type {any} */ (window)).app.getDependency('services').load({ xml }), stableId);
      await waitForTestMessage(consoleLogs, 'UNIT_REVIEW_MODE_AUTO', 15000);
      expect(await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review').isEnabled())).toBe(true);

      const line = await cursorTo(page, 'Alpha');
      await page.evaluate((line) => (/** @type {any} */ (window)).app.getDependency('unit-review').openReview(line), line);
      const popover = page.getByTestId('unit-review-popover');
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('Wrong year');
      await expect(popover).not.toContainText('Your review');
      await expect(popover.getByTestId('unit-review-comment')).toHaveCount(0);
      await expect(popover.getByTestId('unit-review-save')).toHaveCount(0);
      await page.keyboard.press('Escape');
      // the diagnostic offers annotators only to open the review
      const entry = page.locator('.diagnostics-drawer-list', { hasText: 'Marked not OK' });
      await expect(entry.getByText('Open review')).toHaveCount(1);
      await expect(entry.getByText('✓ OK')).toHaveCount(0);
      await expect(entry.getByText('✕ Not OK')).toHaveCount(0);
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review')?.setEnabled(false)).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('a reviewer\'s read-only view follows the annotator\'s changes, and the annotator\'s copy the reviewer\'s', async ({ page, browser }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    const reviewerContext = await browser.newContext();
    const reviewerPage = await reviewerContext.newPage();
    const reviewerLogs = setupTestConsoleCapture(reviewerPage);
    /** @type {string[]} */
    const reviewerDialogs = [];
    reviewerPage.on('dialog', dialog => { reviewerDialogs.push(dialog.message()); dialog.dismiss(); });

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const stableId = await loadReviewDocument(page, STAND_OFF);
      await page.evaluate(async () => {
        const app = (/** @type {any} */ (window)).app;
        const review = app.getDependency('unit-review');
        const unit = review.getUnits().find((/** @type {any} */ u) => u.name === 'bibl');
        await review.setMarks({ id: 'llm-probe', name: 'Probe LLM' }, [{ fingerprint: unit.fingerprint, state: 'not-ok', comment: 'Wrong year' }]);
        await app.getDependency('xmleditor').saveIfDirty();
      });

      // the annotator holds the lock, so the document is read-only for the reviewer
      await navigateAndLogin(reviewerPage, 'testreviewer', 'reviewerpass');
      await reviewerPage.evaluate(async (xml) => (/** @type {any} */ (window)).app.getDependency('services').load({ xml }), stableId);
      await reviewerPage.waitForFunction((xml) => {
        const app = /** @type {any} */ (window).app;
        return app.getCurrentState().xml === xml && app.getCurrentState().editorReadOnly === true
          && app.getDependency('xmleditor').getView().state.doc.toString().includes('Alpha 2001');
      }, stableId, { timeout: 20000 });

      const reviewerLoads = () => reviewerLogs.filter(l => l.message === 'XML_EDITOR_DOCUMENT_LOADED').length;
      const reviewerLoadsBefore = reviewerLoads();
      await page.evaluate(async () => {
        const xmlEditor = (/** @type {any} */ (window)).app.getDependency('xmleditor');
        const view = xmlEditor.getView();
        const pos = view.state.doc.toString().indexOf('Alpha 2001');
        view.dispatch({ changes: { from: pos, to: pos + 'Alpha 2001'.length, insert: 'Alpha 2011' } });
        await xmlEditor.saveIfDirty();
      });

      const followed = await waitForTestMessage(reviewerLogs, 'XML_EDITOR_FOLLOWED_SAVE', 20000);
      expect(await editorText(reviewerPage)).toContain('Alpha 2011');
      // only the changed range was applied, the document was not reloaded
      expect(followed.value?.incremental).toBe(true);
      expect(reviewerLoads()).toBe(reviewerLoadsBefore);
      expect(await reviewerPage.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').isDirty())).toBe(false);
      // no offer to restore a local draft: the reviewer had no unsaved work
      expect(reviewerDialogs).toEqual([]);
      expect(await reviewerPage.evaluate(() => (/** @type {any} */ (window)).app.getCurrentState().editorReadOnly)).toBe(true);
      // the corrected unit asks the reviewer to check it again
      await expect(reviewerPage.getByText('Changed after a not-OK review (Probe LLM: Wrong year), please check again')).toBeVisible({ timeout: 10000 });
      expect(await reviewerPage.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review').isEnabled())).toBe(true);

      // the reviewer marks the corrected unit not OK again: the annotator gets a new message
      const unreadBefore = await page.evaluate(async () => (await (/** @type {any} */ (window)).client.apiClient.messagesCount()).unread);
      await reviewerPage.evaluate(async () => {
        const app = (/** @type {any} */ (window)).app;
        const review = app.getDependency('unit-review');
        const unit = review.getUnits().find((/** @type {any} */ u) => u.name === 'bibl');
        await review.markUnits([unit.fingerprint], 'not-ok', { comment: 'Still wrong' });
        await app.getDependency('xmleditor').saveIfDirty();
      });
      // the badge on the user menu updates live
      await expect(page.getByTestId('toolbar-menu-badge')).toHaveText(String(unreadBefore + 1), { timeout: 10000 });

      // the reviewer's marks reach the annotator's open (editable) copy without a reload
      const summaryNow = async () => summary(page);
      await expect.poll(async () => (await summaryNow()).notOk, { timeout: 10000 }).toBe(1);
      const loadsBefore = consoleLogs.filter(l => l.message === 'XML_EDITOR_DOCUMENT_LOADED').length;
      await reviewerPage.evaluate(async () => {
        const app = (/** @type {any} */ (window)).app;
        const review = app.getDependency('unit-review');
        const unit = review.getUnits().find((/** @type {any} */ u) => u.name === 'bibl');
        await review.markUnits([unit.fingerprint], 'ok');
        await app.getDependency('xmleditor').saveIfDirty();
      });
      await expect.poll(async () => (await summaryNow()).ok, { timeout: 10000 }).toBe(1);
      expect((await summaryNow()).notOk).toBe(0);
      expect(consoleLogs.filter(l => l.message === 'XML_EDITOR_DOCUMENT_LOADED').length).toBe(loadsBefore);

      // so does a new comment thread of the reviewer
      await reviewerPage.evaluate(() => {
        const app = (/** @type {any} */ (window)).app;
        const view = app.getDependency('xmleditor').getView();
        app.getDependency('unit-comments').addComment(view.state.doc.toString().indexOf('Beta 2002'));
      });
      const prompt = reviewerPage.getByTestId('unit-comment-prompt');
      await expect(prompt).toBeVisible();
      await prompt.locator('input').fill('Check the year');
      await prompt.locator('input').press('Enter');
      await reviewerPage.evaluate(async () => (/** @type {any} */ (window)).app.getDependency('xmleditor').saveIfDirty());
      const threadsNow = async () => page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-comments').getThreads());
      await expect.poll(async () => (await threadsNow()).map((/** @type {any} */ t) => t.text), { timeout: 10000 }).toEqual(['Check the year']);
      expect(consoleLogs.filter(l => l.message === 'XML_EDITOR_DOCUMENT_LOADED').length).toBe(loadsBefore);
    } finally {
      await releaseAllLocks(reviewerPage).catch(() => {});
      await performLogout(reviewerPage).catch(() => {});
      await reviewerContext.close();
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('keeps a mark with its unit when an identical unit before it is edited', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadReviewDocument(page, STAND_OFF, TEXT.replace('<bibl>Beta 2002</bibl>', '<bibl>Ibid.</bibl>').replace('<bibl>Gamma 2003</bibl>', '<bibl>Ibid.</bibl>'));
      // a not-OK mark on the first <bibl>Ibid.</bibl>
      await page.evaluate(async () => {
        const review = (/** @type {any} */ (window)).app.getDependency('unit-review');
        const units = review.getUnits();
        await review.setMarks({ id: 'llm-probe', name: 'Probe LLM' }, [{ fingerprint: units[1].fingerprint, state: 'not-ok', comment: 'Tag it' }]);
      });
      const firstIbid = await cursorTo(page, 'Ibid.');
      expect((await summary(page)).notOk).toBe(1);

      // the annotator tags it: the mark must not move to the second <bibl>Ibid.</bibl>
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const pos = view.state.doc.toString().indexOf('Ibid.');
        view.dispatch({ changes: [{ from: pos, insert: '<ref type="precedingWork">' }, { from: pos + 'Ibid.'.length, insert: '</ref>' }] });
      });
      await expect.poll(async () => (await summary(page)).notOk, { timeout: 5000 }).toBe(0);
      const entry = page.locator('.diagnostics-drawer-list', { hasText: 'Changed after a not-OK review' });
      await expect(entry).toContainText(`Line ${firstIbid}`);
      await expect(page.locator('.diagnostics-drawer-list')).not.toContainText('Marked not OK');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('marks only the unit at the cursor when units share a line', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadReviewDocument(page, '', `<text>
    <listBibl>
      <bibl>Alpha 2001</bibl> <bibl>Beta 2002</bibl>
      <bibl>Gamma 2003</bibl>
      <bibl>Delta 2004</bibl>
    </listBibl>
  </text>`);
      await page.locator('[name="unitReviewToggle"]').click();
      await waitForTestMessage(consoleLogs, 'UNIT_REVIEW_MODE');
      await expect(page.getByTestId('unit-review-meter')).toContainText('0 OK · 0 not OK · 4 open');

      // the cursor is in the first unit of the line: only it is marked, the cursor moves to the
      // second unit on the same line
      await cursorTo(page, 'Alpha');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 0 not OK · 3 open');
      const cursor = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        return { head: view.state.selection.main.head, beta: view.state.doc.toString().indexOf('<bibl>Beta') };
      });
      expect(cursor.head).toBe(cursor.beta);

      // a selection marks all units it touches
      await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const text = view.state.doc.toString();
        view.dispatch({ selection: { anchor: text.indexOf('Gamma'), head: text.indexOf('Delta') } });
        view.focus();
      });
      await page.keyboard.press('ControlOrMeta+Enter');
      // Alpha, Gamma and Delta: Beta is still open
      await expect(page.getByTestId('unit-review-meter')).toContainText('3 OK · 0 not OK · 1 open');
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review')?.setEnabled(false)).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('marks units with the keyboard in visual mode', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    // visual mode needs annotation tags for the variant: no extractor of the test setup has any
    await page.route('**/api/v1/extract/list', async route => {
      const response = await route.fetch();
      const extractors = await response.json();
      if (!Array.isArray(extractors)) return route.fulfill({ response });
      const tags = [{ tag: 'bibl', label: 'Bibl', color: '#cc6600' }];
      // the variant of the test documents
      const variant = 'grobid.training.segmentation';
      extractors[0].variants = [...(extractors[0].variants ?? []), variant];
      extractors[0].annotationTags = { ...extractors[0].annotationTags, [variant]: tags };
      await route.fulfill({ response, json: extractors });
    });

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadReviewDocument(page);
      await page.locator('[name="unitReviewToggle"]').click();
      await waitForTestMessage(consoleLogs, 'UNIT_REVIEW_MODE');
      await expect(page.locator('[name="annotationModeSwitch"]')).toBeVisible();
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation').dispatchStateChange({ view: 'annotation' }));
      await page.waitForFunction(() => (/** @type {any} */ (window)).app.getDependency('xmleditor').isReadOnly());

      // a click puts the cursor into the unit and the keyboard focus into the editor
      const alpha = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Alpha') + 2);
        return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(alpha.x, alpha.y);
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('unit-review-meter')).toContainText('1 OK · 0 not OK · 2 open');
      const lines = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        return {
          cursor: view.state.doc.lineAt(view.state.selection.main.head).number,
          beta: view.state.doc.lineAt(view.state.doc.toString().indexOf('Beta')).number
        };
      });
      expect(lines.cursor).toBe(lines.beta);

      // the text cannot be edited with the keyboard
      const before = await editorText(page);
      for (const key of ['Backspace', 'Delete', 'Enter', 'Tab']) await page.keyboard.press(key);
      expect(await editorText(page)).toBe(before);
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('xml-annotation')?.dispatchStateChange({ view: null })).catch(() => {});
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review')?.setEnabled(false)).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('is read-only for annotators', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadReviewDocument(page, STAND_OFF);
      // standOff is folded on load
      await expect(page.locator('#codemirror-container .cm-content')).toContainText('Alpha 2001');
      await expect(page.locator('#codemirror-container .cm-content')).not.toContainText('unit-xpath');
      await page.locator('[name="unitReviewToggle"]').click();
      await expect(page.getByTestId('unit-review-meter')).toContainText('3 open');
      await cursorTo(page, 'Alpha');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.locator('sl-alert', { hasText: 'Only reviewers can mark units.' })).toHaveCount(1);
      expect(await editorText(page)).not.toContain('<annotation');
      // the context menu row offers only navigation
      const betaPoint = await page.evaluate(() => {
        const view = (/** @type {any} */ (window)).app.getDependency('xmleditor').getView();
        const coords = view.coordsAtPos(view.state.doc.toString().indexOf('Beta') + 2);
        return { x: coords.left, y: (coords.top + coords.bottom) / 2 };
      });
      await page.mouse.click(betaPoint.x, betaPoint.y, { button: 'right' });
      const menuRow = page.getByTestId('unit-review-menu-row');
      await expect(menuRow).toBeVisible();
      await expect(menuRow.getByTestId('unit-review-menu-check-lg')).toBeDisabled();
      await expect(menuRow.getByTestId('unit-review-menu-arrow-down-circle')).toBeEnabled();
      await page.keyboard.press('Escape');
    } finally {
      await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('unit-review')?.setEnabled(false)).catch(() => {});
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

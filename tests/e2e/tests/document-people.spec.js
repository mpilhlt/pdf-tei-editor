/**
 * Document people end-to-end tests
 *
 * A reviewer opens the People dialog from the XML editor toolbar, adds a user with a
 * responsibility that matches the user's roles (written as a respStmt into the header and saved),
 * and sends that person a message, which the recipient finds in their messages and which is not
 * stored in the document. An annotator sees the dialog without the "Add a person" section.
 *
 * @testCovers app/src/plugins/document-people.js
 * @testCovers app/src/modules/document-people.js
 * @testCovers app/src/templates/document-people-dialog.html
 * @testCovers app/src/plugins/messages.js
 * @testCovers fastapi_app/routers/messages.py
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

const MESSAGE = 'Please annotate the references of this document';

/**
 * Saves the loaded document as a new version (the fixture must not be changed) and loads it.
 * @param {Page} page
 * @returns {Promise<void>}
 */
async function loadEditableVersion(page) {
  const stableId = await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const res = await w.client.apiClient.filesSave({
      xml_string: w.app.getDependency('xmleditor').getXML(),
      file_id: 'document-people-probe',
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
 * Selects a value in one of the dialog's selects.
 * @param {Page} page
 * @param {string} testId
 * @param {string} value
 */
async function selectValue(page, testId, value) {
  await page.evaluate(({ testId, value }) => {
    const select = /** @type {any} */ (document.querySelector(`[data-testid="${testId}"]`));
    select.value = value;
    select.dispatchEvent(new CustomEvent('sl-change', { bubbles: true }));
  }, { testId, value });
}

/**
 * The values of the options of one of the dialog's selects.
 * @param {Page} page
 * @param {string} testId
 * @returns {Promise<string[]>}
 */
async function optionValues(page, testId) {
  return page.evaluate((testId) => Array.from(document.querySelectorAll(`[data-testid="${testId}"] sl-option`))
    .map(option => option.getAttribute('value') ?? ''), testId);
}

async function openDialog(/** @type {Page} */ page) {
  await page.locator('[data-testid="document-people-btn"]').click();
  await expect(page.locator('sl-dialog[name="documentPeopleDialog"]')).toHaveAttribute('open', '');
  await page.waitForTimeout(500);
}

test.describe('Document people', () => {

  test('a reviewer adds a person and sends a message, which the recipient receives', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await loadEditableVersion(page);

      await openDialog(page);
      await expect(page.locator('[data-testid="document-people-add"]')).toBeVisible();

      // the responsibilities offered match the roles of the selected user
      await selectValue(page, 'document-people-user', 'testuser');
      expect(await optionValues(page, 'document-people-role')).toEqual(['commenter']);
      await selectValue(page, 'document-people-user', 'testannotator');
      expect(await optionValues(page, 'document-people-role')).toEqual(['annotator', 'commenter']);
      await selectValue(page, 'document-people-role', 'annotator');
      const isHeaderFolded = () => page.evaluate(() =>
        /** @type {any} */ (window).app.getDependency('xmleditor').isFoldedByXpath('//tei:teiHeader'));
      expect(await isHeaderFolded()).toBe(true);
      await page.locator('[data-testid="document-people-add-btn"]').click();
      await waitForTestMessage(consoleLogs, 'DOCUMENT_PEOPLE_ADDED');
      // the header keeps its fold state
      expect(await isHeaderFolded()).toBe(true);

      // written into the header and saved
      const row = page.locator('[data-testid="document-people-row"][data-id="testannotator"]');
      await expect(row).toContainText('Test Annotator');
      await expect(row).toContainText('Annotator');
      await expect(row).toContainText('0 edits · 0 comments');
      const xml = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getXML());
      expect(xml).toMatch(/<respStmt>\s*<persName xml:id="testannotator">Test Annotator<\/persName>\s*<resp>Annotator<\/resp>\s*<\/respStmt>/);
      await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').isDirty())).toBe(false);

      // the responsibility the person has is no longer offered
      await selectValue(page, 'document-people-user', 'testannotator');
      expect(await optionValues(page, 'document-people-role')).toEqual(['commenter']);

      // a message to the person
      await row.locator('[data-testid="document-people-message-btn"]').click();
      const input = row.locator('[data-testid="document-people-message-input"] input');
      await input.fill(MESSAGE);
      await input.press('Enter');
      await waitForTestMessage(consoleLogs, 'DOCUMENT_PEOPLE_MESSAGE_SENT');
      await expect(row.locator('[data-testid="document-people-message-input"]')).toHaveCount(0);
      const saved = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getXML());
      expect(saved).not.toContain(MESSAGE);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
    }

    try {
      // the recipient finds the message; annotators cannot add people
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const messages = await page.evaluate(async () =>
        /** @type {any} */ (window).client.apiClient.messagesList({ kind: 'direct' }));
      const message = messages.items.find((/** @type {any} */ m) => m.text === MESSAGE);
      expect(message).toBeTruthy();
      expect(message.author).toBe('testreviewer');
      expect(message.kind).toBe('direct');

      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await openDialog(page);
      await expect(page.locator('[data-testid="document-people-add"]')).toBeHidden();
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});

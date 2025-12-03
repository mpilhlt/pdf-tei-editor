/**
 * Document actions end-to-end tests
 *
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/services.js
 * @testCovers server/api/files.py
 *
 */

/**
 * @import { namedElementsTree } from '../../app/src/ui.js'
 */

// Use custom test fixture for debug-on-failure support
import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';
import { debugLog } from './helpers/debug-helpers.js';

// Define allowed error patterns for document actions
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
  'Failed to load resource.*400.*BAD REQUEST', // Autocomplete validation errors
  'Failed to load autocomplete data.*No schema location found', // Expected validation warnings
  'api/validate/autocomplete-data.*400.*BAD REQUEST', // Schema validation API errors
  'offsetParent is not set.*cannot scroll', // UI scrolling errors in browser automation
  'Failed to load resource.*403.*FORBIDDEN', // Access control errors - temporarily allowed
  'Failed to load resource.*423.*LOCKED', // File locking conflicts between tests
  'Error while saving XML.*Only users with reviewer role.*', // Role permission errors
  'Error.*Could not save XML.*Failed to acquire lock', // File locking conflicts
  'Error while saving XML.*Failed to acquire lock' // Alternative file locking error format
];

test.describe('Document Actions', () => {

  test('should create new version from existing document', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as reviewer (required for document actions)
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Select the first available PDF and XML documents (should exist from previous tests)
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true)

      // Debug: Check button state and available documents
      const debugInfo = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        /** @type {any} */
        const app = /** @type {any} */(window).app;
        const state = app.getCurrentState();
        return {
          pdfOptionsCount: ui.toolbar.pdf.querySelectorAll('sl-option').length,
          xmlOptionsCount: ui.toolbar.xml.querySelectorAll('sl-option').length,
          pdfValue: ui.toolbar.pdf.value,
          xmlValue: ui.toolbar.xml.value,
          createNewVersionEnabled: !ui.toolbar.documentActions.createNewVersion.disabled,
          stateXml: state.xml,
          statePdf: state.pdf
        };
      });
      debugLog(debugInfo);

      // Verify button is enabled before clicking
      const isButtonEnabled = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return !ui.toolbar.documentActions.createNewVersion.disabled;
      });

      expect(isButtonEnabled).toBe(true);

      // Click on create new version button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.createNewVersion.click();
      });

      // Wait for new version dialog to open
      await page.waitForSelector('sl-dialog[name="newVersionDialog"][open]', { timeout: 5000 });

      // Fill in the version dialog form
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newVersionDialog.versionName.value = 'Test Version E2E';
        ui.newVersionDialog.persName.value = 'Test User';
        ui.newVersionDialog.persId.value = 'TU';
        ui.newVersionDialog.editionNote.value = 'Created via E2E test';
      });

      // Submit the new version dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newVersionDialog.submit.click();
      });

      // Wait for new version creation to complete
      const newVersionLog = await waitForTestMessage(consoleLogs, 'NEW_VERSION_CREATED', 10000);
      expect(newVersionLog.value).toHaveProperty('oldFileId');
      expect(newVersionLog.value).toHaveProperty('newFileId');
      //expect(newVersionLog.value.newFileId).not.toBe(newVersionLog.value.oldFileId); // ??

      debugLog('New version creation test completed successfully');

      // Note: We don't delete the created version here because:
      // 1. Tests should not modify fixture data
      // 2. The database is cleaned between test runs (--clean-db default)
      // 3. Deleting during test affects subsequent tests in the same run

    } finally {
      // Release all locks before logout
      await releaseAllLocks(page);
      await performLogout(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('should save revision for existing document', async ({ page }) => {

    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection (excluding file lock errors for this test)
    const allowedErrorsForRevision = [
      ...ALLOWED_ERROR_PATTERNS
    ];
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, allowedErrorsForRevision);

    try {
      // Navigate and login as reviewer (required for document actions)
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Select the first available PDF and XML documents (should exist from previous tests)
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Debug: Check button state and available documents
      const uiState1 = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        /** @type {any} */
        const app = /** @type {any} */(window).app;
        const state = app.getCurrentState();
        return {
          pdfOptionsCount: ui.toolbar.pdf.querySelectorAll('sl-option').length,
          xmlOptionsCount: ui.toolbar.xml.querySelectorAll('sl-option').length,
          pdfValue: ui.toolbar.pdf.value,
          xmlValue: ui.toolbar.xml.value,
          userRoles: state.user?.roles,
          saveRevisionEnabled: !ui.toolbar.documentActions.saveRevision.disabled
        };
      });
      debugLog(uiState1);

      // Verify button is enabled before clicking
      const uiState2 = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        /** @type {any} */
        const app = /** @type {any} */(window).app;
        const state = app.getCurrentState();
        return {
          saveRevisionButtonEnabled: !ui.toolbar.documentActions.saveRevision.disabled,
          hasXml: Boolean(state.xml),
          editorReadOnly: state.editorReadOnly,
          xmlValue: ui.toolbar.xml.value,
          pdfValue: ui.toolbar.pdf.value
        };
      });
      debugLog(uiState2)
      expect(uiState2.saveRevisionButtonEnabled).toBe(true);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for revision dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Fill out the revision change description
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.changeDesc.value = 'E2E test revision description';
        ui.newRevisionChangeDialog.persId.value = 'testuser';
        ui.newRevisionChangeDialog.persName.value = 'Test User';
      });

      // Submit the revision dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.submit.click();
      });

      // Wait a moment for dialog to close and processing to start
      await page.waitForTimeout(500);

      // Wait for revision to be saved
      const revisionLog = await waitForTestMessage(consoleLogs, 'REVISION_SAVED', 20000);
      expect(revisionLog.value).toHaveProperty('changeDescription');
      expect(revisionLog.value.changeDescription).toBe('E2E test revision description');

      // Wait for verification that revision exists in XML document
      const xmlVerificationLog = await waitForTestMessage(consoleLogs, 'REVISION_IN_XML_VERIFIED', 5000);
      expect(xmlVerificationLog.value).toHaveProperty('changeDescription', 'E2E test revision description');
      expect(xmlVerificationLog.value).toHaveProperty('xmlContainsRevision', true);

      debugLog('Revision save test completed successfully');
    } finally {
      // Release all locks before logout
      await releaseAllLocks(page);
      await performLogout(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });
});
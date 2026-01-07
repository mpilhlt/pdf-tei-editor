/**
 * Document actions end-to-end tests
 *
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/document-actions.js
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

      await page.waitForTimeout(500);

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

      // Verify that buttons are enabled after creating new version (not read-only)
      await page.waitForTimeout(1000); // Wait for state update
      const buttonsEnabledAfterCreate = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          saveRevision: !ui.toolbar.documentActions.saveRevision.disabled,
          createNewVersion: !ui.toolbar.documentActions.createNewVersion.disabled,
          editMetadata: !ui.toolbar.documentActions.editMetadata.disabled
        };
      });

      expect(buttonsEnabledAfterCreate.saveRevision).toBe(true);
      expect(buttonsEnabledAfterCreate.createNewVersion).toBe(true);
      expect(buttonsEnabledAfterCreate.editMetadata).toBe(true);

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

      await page.waitForTimeout(500);

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

      await page.waitForTimeout(500);

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

  test('should save revision as gold version (reviewer only)', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as reviewer (required for gold version actions)
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Select the first available PDF and XML documents
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Get initial file ID and gold status for later verification
      const initialFileInfo = await page.evaluate(() => {
        /** @type {any} */
        const app = /** @type {any} */(window).app;
        const state = app.getCurrentState();
        const xmlId = state.xml;

        // Check if current file is gold
        let isCurrentlyGold = false;
        for (const doc of state.fileData) {
          if (doc.artifacts) {
            const artifact = doc.artifacts.find(a => a.id === xmlId);
            if (artifact) {
              isCurrentlyGold = artifact.is_gold_standard === true;
              break;
            }
          }
        }

        return { xmlId, isCurrentlyGold };
      });
      debugLog('Initial file info:', initialFileInfo);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for revision dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Verify the "Save as Gold Version" checkbox is visible for reviewers
      const checkboxState = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          exists: Boolean(ui.newRevisionChangeDialog.saveAsGold),
          visible: ui.newRevisionChangeDialog.saveAsGold.style.display !== 'none',
          checked: ui.newRevisionChangeDialog.saveAsGold.checked
        };
      });
      debugLog('Checkbox state:', checkboxState);
      expect(checkboxState.exists).toBe(true);
      expect(checkboxState.visible).toBe(true);
      // Checkbox should be checked if the current file is already gold, unchecked otherwise
      expect(checkboxState.checked).toBe(initialFileInfo.isCurrentlyGold);

      // Fill out the revision form and check the gold checkbox
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.changeDesc.value = 'E2E test gold revision';
        ui.newRevisionChangeDialog.persId.value = 'testuser';
        ui.newRevisionChangeDialog.persName.value = 'Test User';
        ui.newRevisionChangeDialog.saveAsGold.checked = true;
      });

      await page.waitForTimeout(500);

      // Submit the revision dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.submit.click();
      });

      // Wait for revision to be saved
      const revisionLog = await waitForTestMessage(consoleLogs, 'REVISION_SAVED', 20000);
      expect(revisionLog.value).toHaveProperty('changeDescription', 'E2E test gold revision');

      // Wait for gold standard to be set
      const goldLog = await waitForTestMessage(consoleLogs, 'GOLD_STANDARD_SET', 10000);
      expect(goldLog.value).toHaveProperty('fileId');
      expect(goldLog.value.fileId).toBe(initialFileInfo.xmlId);

      // Verify the file is now marked as gold in the UI
      // Wait a moment for file data to reload
      await page.waitForTimeout(2000);

      const finalGoldStatus = await page.evaluate(() => {
        /** @type {any} */
        const app = /** @type {any} */(window).app;
        const state = app.getCurrentState();
        const xmlId = state.xml;

        // Access fileData and check is_gold_standard property directly
        const fileData = state.fileData;

        // Find the artifact with matching ID
        for (const doc of fileData) {
          if (doc.artifacts) {
            const artifact = doc.artifacts.find(a => a.id === xmlId);
            if (artifact) {
              return {
                xmlId: xmlId,
                isGold: artifact.is_gold_standard === true
              };
            }
          }
        }

        return { xmlId: xmlId, isGold: false };
      });
      debugLog('Final gold status:', finalGoldStatus);
      expect(finalGoldStatus.isGold).toBe(true);

      debugLog('Save revision as gold test completed successfully');
    } finally {
      // Release all locks before logout
      await releaseAllLocks(page);
      await performLogout(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('should hide gold checkbox for non-reviewers', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as annotator (not a reviewer)
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');

      // Select first document and create a new version (non-gold) to work with
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      // Create a new version from the gold file
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.createNewVersion.click();
      });

      // Wait for new version dialog
      await page.waitForSelector('sl-dialog[name="newVersionDialog"][open]', { timeout: 5000 });

      // Fill in version details
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newVersionDialog.versionName.value = 'Test Version for Annotator';
        ui.newVersionDialog.editionNote.value = 'Created for test';
      });

      await page.waitForTimeout(500);

      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newVersionDialog.submit.click();
      });

      // Wait for version creation
      await page.waitForTimeout(3000);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for revision dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Verify the "Save as Gold Version" checkbox is hidden for non-reviewers
      const checkboxState = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          exists: Boolean(ui.newRevisionChangeDialog.saveAsGold),
          visible: ui.newRevisionChangeDialog.saveAsGold.style.display !== 'none'
        };
      });
      debugLog('Checkbox state for annotator:', checkboxState);
      expect(checkboxState.exists).toBe(true);
      expect(checkboxState.visible).toBe(false);

      // Close the dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.cancel.click();
      });

      debugLog('Gold checkbox visibility test completed successfully');
    } finally {
      // Release all locks before logout
      await releaseAllLocks(page);
      await performLogout(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('should pre-fill status from last change element', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Login as reviewer
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Select documents
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Verify status select is present and has a value
      const statusState = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          exists: Boolean(ui.newRevisionChangeDialog.status),
          value: ui.newRevisionChangeDialog.status.value,
          optionsCount: ui.newRevisionChangeDialog.status.querySelectorAll('sl-option').length
        };
      });
      debugLog('Status select state:', statusState);
      expect(statusState.exists).toBe(true);
      expect(statusState.optionsCount).toBe(6); // extraction, draft, checked, approved, candidate, published
      expect(['extraction', 'draft', 'checked', 'approved', 'candidate', 'published']).toContain(statusState.value);

      // Close the dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.cancel.click();
      });

      debugLog('Status pre-fill test completed successfully');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('should restrict status options for annotators', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Login as annotator (not reviewer)
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');

      // Select first document and create a new version (non-gold) to work with
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      // Create a new version from the gold file
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.createNewVersion.click();
      });

      // Wait for new version dialog
      await page.waitForSelector('sl-dialog[name="newVersionDialog"][open]', { timeout: 5000 });

      // Fill in version details
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newVersionDialog.versionName.value = 'Test Version for Status Check';
        ui.newVersionDialog.editionNote.value = 'Created for test';
      });

      await page.waitForTimeout(500);

      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newVersionDialog.submit.click();
      });

      // Wait for version creation
      await page.waitForTimeout(3000);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Check which options are disabled
      const optionStates = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        const options = Array.from(ui.newRevisionChangeDialog.status.querySelectorAll('sl-option'));
        return options.map(opt => ({
          value: opt.value,
          disabled: opt.disabled
        }));
      });
      debugLog('Status options for annotator:', optionStates);

      // Verify restricted options are disabled
      const approvedOpt = optionStates.find(o => o.value === 'approved');
      const candidateOpt = optionStates.find(o => o.value === 'candidate');
      const publishedOpt = optionStates.find(o => o.value === 'published');
      const draftOpt = optionStates.find(o => o.value === 'draft');
      const checkedOpt = optionStates.find(o => o.value === 'checked');

      expect(approvedOpt?.disabled).toBe(true);
      expect(candidateOpt?.disabled).toBe(true);
      expect(publishedOpt?.disabled).toBe(true);
      expect(draftOpt?.disabled).toBe(false);
      expect(checkedOpt?.disabled).toBe(false);

      // Close the dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.cancel.click();
      });

      debugLog('Status restriction test completed successfully');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('should allow all status options for reviewers', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Login as reviewer
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Select documents
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Check all options are enabled
      const optionStates = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        const options = Array.from(ui.newRevisionChangeDialog.status.querySelectorAll('sl-option'));
        return options.map(opt => ({
          value: opt.value,
          disabled: opt.disabled
        }));
      });
      debugLog('Status options for reviewer:', optionStates);

      // Verify we have all 6 status options
      expect(optionStates.length).toBe(6);

      // Verify all options are enabled (reviewers have both reviewer and annotator roles)
      // Expected: 
      // - extraction => false
      // - draft, checked (annotator) => true
      // - approved, candidate, published (reviewer) = true
      optionStates.forEach(opt => {
        expect(opt.disabled).toBe(opt.value === "extraction");
      });

      // Close the dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.cancel.click();
      });

      debugLog('Status options test for reviewer completed successfully');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('should save status to change element', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Login as reviewer
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Select documents
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForTimeout(1000);

      // Click save revision button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.documentActions.saveRevision.click();
      });

      // Wait for dialog to open
      await page.waitForSelector('sl-dialog[name="newRevisionChangeDialog"][open]', { timeout: 5000 });

      // Fill out the form with a specific status
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.newRevisionChangeDialog.changeDesc.value = 'E2E test status save';
        ui.newRevisionChangeDialog.status.value = 'checked';
      });

      await page.waitForTimeout(500);

      // Submit the revision dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        console.warn("Clicking!!")
        ui.newRevisionChangeDialog.submit.click();
        console.warn("Clicked!!")
      });

      // Wait for revision to be saved and verify status
      const revisionLog = await waitForTestMessage(consoleLogs, 'REVISION_SAVED', 20000);
      debugLog('Revision saved with status:', revisionLog.value);
      expect(revisionLog.value).toHaveProperty('changeDescription', 'E2E test status save');
      expect(revisionLog.value).toHaveProperty('status', 'checked');

      debugLog('Status save test completed successfully');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });
});
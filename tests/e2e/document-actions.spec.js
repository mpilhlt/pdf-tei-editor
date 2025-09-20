/**
 * Document actions end-to-end tests
 *
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/services.js
 * @testCovers server/api/files.py
 */

/** @import { namedElementsTree } from '../../app/src/ui.js' */

import { test, expect } from '@playwright/test';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

// Enable debug output only when E2E_DEBUG environment variable is set
const DEBUG = process.env.E2E_DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};

// Configuration from environment variables
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

// Define allowed error patterns for document actions
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
  'Failed to load resource.*400.*BAD REQUEST', // Autocomplete validation errors
  'Failed to load autocomplete data.*No schema location found', // Expected validation warnings
  'api/validate/autocomplete-data.*400.*BAD REQUEST', // Schema validation API errors
  'offsetParent is not set.*cannot scroll' // UI scrolling errors in browser automation
];

test.describe('Document Actions', () => {

  test('should create new version from existing document', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login
      await navigateAndLogin(page, E2E_BASE_URL);

      // Select the first available PDF and XML documents (should exist from previous tests)
      await selectFirstDocuments(page);

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Debug: Check button state and available documents
      const debugInfo = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          pdfOptionsCount: ui.toolbar.pdf.querySelectorAll('sl-option').length,
          xmlOptionsCount: ui.toolbar.xml.querySelectorAll('sl-option').length,
          pdfValue: ui.toolbar.pdf.value,
          xmlValue: ui.toolbar.xml.value,
          createNewVersionDisabled: ui.toolbar.documentActions.createNewVersion.disabled,
          saveRevisionDisabled: ui.toolbar.documentActions.saveRevision.disabled
        };
      });
      debugLog('Debug info:', debugInfo);

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
      expect(newVersionLog.value).toHaveProperty('oldHash');
      expect(newVersionLog.value).toHaveProperty('newHash');
      expect(newVersionLog.value.newHash).not.toBe(newVersionLog.value.oldHash);

      debugLog('New version creation test completed successfully');

    } finally {
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close()
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

    let currentXmlFileId = null;

    try {
      // Navigate and login
      await navigateAndLogin(page, E2E_BASE_URL);

      // Select the first available PDF and XML documents (should exist from previous tests)
      await selectFirstDocuments(page);

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Debug: Check button state and available documents
      const debugInfo = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          pdfOptionsCount: ui.toolbar.pdf.querySelectorAll('sl-option').length,
          xmlOptionsCount: ui.toolbar.xml.querySelectorAll('sl-option').length,
          pdfValue: ui.toolbar.pdf.value,
          xmlValue: ui.toolbar.xml.value,
          createNewVersionDisabled: ui.toolbar.documentActions.createNewVersion.disabled,
          saveRevisionDisabled: ui.toolbar.documentActions.saveRevision.disabled
        };
      });
      debugLog('Debug info:', debugInfo);

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

      // Wait for revision to be saved
      const revisionLog = await waitForTestMessage(consoleLogs, 'REVISION_SAVED', 15000);
      expect(revisionLog.value).toHaveProperty('changeDescription');
      expect(revisionLog.value.changeDescription).toBe('E2E test revision description');

      // Wait for verification that revision exists in XML document
      const xmlVerificationLog = await waitForTestMessage(consoleLogs, 'REVISION_IN_XML_VERIFIED', 5000);
      expect(xmlVerificationLog.value).toHaveProperty('changeDescription', 'E2E test revision description');
      expect(xmlVerificationLog.value).toHaveProperty('xmlContainsRevision', true);

      debugLog('Revision save test completed successfully');
    } finally {
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close()
    }
  });
});
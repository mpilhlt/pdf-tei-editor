/**
 * Extraction workflow end-to-end tests
 *
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/services.js
 * @testCovers server/api/files.py
 */

/** @import { namedElementsTree } from '../../../app/src/ui.js' */

import { test, expect } from '@playwright/test';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

// Define allowed error patterns for extraction workflow
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
  'Failed to load resource.*400.*BAD REQUEST', // Autocomplete validation errors
  'Failed to load resource.*409.*CONFLICT', // Resource conflict errors during extraction
  'Failed to load autocomplete data.*No schema location found', // Expected validation warnings
  'api/validate/autocomplete-data.*400.*BAD REQUEST', // Schema validation API errors
  'offsetParent is not set.*cannot scroll', // UI scrolling errors in browser automation
  'Failed to load resource.*404.*NOT FOUND', // Resource access control errors
  'ApiError.*Hash.*not found in lookup table' // Test data availability issues
];

// Enable debug output only when E2E_DEBUG environment variable is set
const DEBUG = process.env.E2E_DEBUG === 'true';
/**
 * @param {...any} args - Debug log arguments
 */
const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};

// Configuration from environment variables
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

// Helper functions are now imported from test-logging.js

// Helper functions for extraction workflow steps
/**
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @returns {Promise<boolean>} - Whether extraction is available
 */
async function checkExtractionAvailability(page) {
  // Since we now have fallback to mock extractor, extraction is always available
  debugLog('Extraction availability: Using fallback to mock extractor when external dependencies are missing');
  return true;
}

/**
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {string} filePath - Path to the PDF file to upload
 * @returns {Promise<string>} - The uploaded file path
 */
async function uploadPDFFile(page, filePath) {
  debugLog('Starting PDF upload phase...');

  // Set up file input handling before clicking the button
  const fileChooserPromise = page.waitForEvent('filechooser');

  // Click extract new button to open file selection dialog
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.toolbar.extractionActions.extractNew.click();
  });
  debugLog('Extract new button clicked');

  // Wait for and handle the file chooser dialog
  const fileChooser = await fileChooserPromise;
  debugLog('File chooser appeared, setting file:', filePath);
  await fileChooser.setFiles(filePath);
  debugLog('File set, waiting for upload completion...');

  return filePath;
}

/**
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {any[]} consoleLogs - Console log capture array
 * @returns {Promise<any>} - Upload completion log
 */
async function waitForPDFUploadCompletion(page, consoleLogs) {
  debugLog('Waiting for PDF upload completion...');

  // Wait for PDF upload completion with debugging
  const uploadLog = await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 10000);
  debugLog('Found PDF_UPLOAD_COMPLETED:', uploadLog);

  expect(uploadLog.value).toHaveProperty('originalFilename');
  expect(uploadLog.value).toHaveProperty('filename');

  // Verify that the UI is in the correct state after upload using window.ui
  const uiState = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    return {
      extractionActionsVisible: ui.toolbar.extractionActions && ui.toolbar.extractionActions.style.display !== 'none',
      extractNewEnabled: ui.toolbar.extractionActions.extractNew && !ui.toolbar.extractionActions.extractNew.disabled
    };
  });
  expect(uiState.extractionActionsVisible).toBe(true);
  debugLog('UI state after upload verified:', uiState);

  return uploadLog;
}

/**
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {any[]} consoleLogs - Console log capture array
 * @param {string} modelIndex - Model index to use for extraction
 * @returns {Promise<void>}
 */
async function configureExtractionOptions(page, consoleLogs, modelIndex = 'llamore-gemini') {
  debugLog('Starting extraction configuration phase...');

  // Wait for extraction options dialog to appear
  await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 10000);
  debugLog('Extraction options dialog starting event received');

  // Verify the extraction options dialog is open using window.ui
  const dialogOpen = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    return ui.extractionOptions && ui.extractionOptions.open;
  });
  expect(dialogOpen).toBe(true);
  debugLog('Extraction options dialog confirmed open');

  // Fill out the extraction options dialog
  await page.evaluate(/* @param {string} model */ (model) => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    // Set the extractor model
    ui.extractionOptions.modelIndex.value = model;
    // Submit the dialog
    ui.extractionOptions.submit.click();
  }, modelIndex);
  debugLog('Extraction options configured and submitted with model:', modelIndex);
}

/**
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {any[]} consoleLogs - Console log capture array
 * @returns {Promise<any>} - Extraction completion log
 */
async function waitForExtractionCompletion(page, consoleLogs) {
  debugLog('Waiting for extraction to complete...');

  // Wait for extraction to complete (this can take time)
  const extractionLog = await waitForTestMessage(consoleLogs, 'EXTRACTION_COMPLETED', 60000);
  debugLog('Extraction completed:', extractionLog);

  expect(extractionLog.value).toHaveProperty('resultHash');

  // Verify that extraction dialog has closed using window.ui
  const dialogClosed = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    return !ui.extractionOptions.open;
  });
  expect(dialogClosed).toBe(true);
  debugLog('Extraction options dialog confirmed closed');

  return extractionLog;
}

/**
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {any[]} consoleLogs - Console log capture array
 * @returns {Promise<void>}
 */
async function waitForDocumentLoad(page, consoleLogs) {
  debugLog('Waiting for document to load in XML editor...');

  // Wait for the extracted document to be shown in the editor
  await waitForTestMessage(consoleLogs, 'XML_EDITOR_DOCUMENT_LOADED', 10000);
  debugLog('XML editor document loaded');

  // Verify XML editor is visible using window.ui
  const editorVisible = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    return ui.xmlEditor && ui.xmlEditor.style.display !== 'none';
  });
  expect(editorVisible).toBe(true);
  debugLog('XML editor visibility confirmed');
}

test.describe.serial('Extraction Workflow', () => {

  test('should complete PDF extraction workflow', async ({ page }) => {
    test.setTimeout(60000); // 60 seconds for extraction workflow

    // Check if extraction is available (either external services or mock)
    const extractionAvailable = await checkExtractionAvailability(page);
    if (!extractionAvailable) {
      test.skip();
      return;
    }

    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    // main test
    try {
      debugLog('Starting extraction workflow test');

      // Navigate and login as annotator (required for extraction operations)
      await navigateAndLogin(page, E2E_BASE_URL, 'testannotator', 'annotatorpass');
      debugLog('Login completed');

      // Debug: Check if test logging is enabled
      const testLogStatus = await page.evaluate(() => {
        return {
          testLogAvailable: typeof (/** @type {any} */(window)).testLog === 'function',
          applicationMode: (/** @type {any} */(window)).application?.config?.get ? 'config available' : 'config not available'
        };
      });
      debugLog('Test log status:', testLogStatus);

      // Step 1: Upload PDF file
      await uploadPDFFile(page, 'demo/data/pdf/example/10.5771__2699-1284-2024-3-149.pdf');

      // Step 2: Wait for upload completion
      await waitForPDFUploadCompletion(page, consoleLogs);

      // Step 3: Configure extraction options
      await configureExtractionOptions(page, consoleLogs, 'llamore-gemini');

      // Step 4: Wait for extraction completion
      const extractionLog = await waitForExtractionCompletion(page, consoleLogs);

      // Step 5: Wait for document to load in editor
      await waitForDocumentLoad(page, consoleLogs);

      // Final validation: Get initial state from extraction completion log
      const initialXmlState = extractionLog.value.resultHash;
      expect(initialXmlState).toBeTruthy();
      debugLog('Final validation passed - result hash:', initialXmlState);

      // Additional final UI state verification
      const finalUIState = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return {
          xmlEditorLoaded: ui.xmlEditor && ui.xmlEditor.style.display !== 'none',
          toolbarVisible: ui.toolbar && ui.toolbar.style.display !== 'none',
          extractionActionsVisible: ui.toolbar.extractionActions && ui.toolbar.extractionActions.style.display !== 'none'
        };
      });
      debugLog('Final UI state verification:', finalUIState);
      expect(finalUIState.xmlEditorLoaded).toBe(true);
      expect(finalUIState.toolbarVisible).toBe(true);

      debugLog('PDF extraction workflow completed successfully');

    } finally {
      // cleanup
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });

});
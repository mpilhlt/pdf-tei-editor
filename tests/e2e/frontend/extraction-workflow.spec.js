/**
 * Extraction workflow end-to-end tests
 *
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/services.js
 * @testCovers server/api/files.py
 * @env GROBID_SERVER_URL
 * @env GEMINI_API_KEY
 */

/** @import { namedElementsTree } from '../../app/src/ui.js' */

import { test, expect } from '@playwright/test';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from '../helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from '../helpers/login-helper.js';

// Define allowed error patterns for extraction workflow
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
  'Failed to load resource.*400.*BAD REQUEST', // Autocomplete validation errors
  'Failed to load autocomplete data.*No schema location found', // Expected validation warnings
  'api/validate/autocomplete-data.*400.*BAD REQUEST', // Schema validation API errors
  'offsetParent is not set.*cannot scroll', // UI scrolling errors in browser automation
  'Failed to load resource.*404.*NOT FOUND', // Resource access control errors
  'ApiError.*Hash.*not found in lookup table' // Test data availability issues
];

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

// Helper functions are now imported from test-logging.js

test.describe.serial('Extraction Workflow', () => {

  test('should complete PDF extraction workflow', async ({ page }) => {
    test.setTimeout(60000); // 60 seconds for extraction workflow

    // First check if Grobid server is available
    const grobidResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('https://lfoppiano-grobid-dev-dh-law.hf.space/api/version');
        if (response.ok) {
          const data = await response.json();
          return { status: response.status, data };
        }
        return { status: response.status, error: `HTTP ${response.status}` };
      } catch (error) {
        return { error: String(error) };
      }
    });

    // Output Grobid server information
    if (grobidResponse.error) {
      console.log('Grobid server not reachable:', grobidResponse.error);
      test.skip();
      return;
    } else {
      console.log('Grobid server version:', grobidResponse.data);
      expect(grobidResponse.data).toHaveProperty('version');
      expect(grobidResponse.data).toHaveProperty('revision');
    }

    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    // main test
    try {

      // Navigate and login as annotator (required for extraction operations)
      await navigateAndLogin(page, E2E_BASE_URL, 'testannotator', 'annotatorpass');

      // Debug: Check if test logging is enabled
      const testLogStatus = await page.evaluate(() => {
        // @ts-ignore
        return {
          testLogAvailable: typeof window.testLog === 'function',
          applicationMode: window.application?.config?.get ? 'config available' : 'config not available'
        };
      });
      debugLog('Test log status:', testLogStatus);

      // Set up file input handling before clicking the button
      // This handles the programmatic file input that gets created dynamically
      const fileChooserPromise = page.waitForEvent('filechooser');

      // Click extract new button to open file selection dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.extractionActions.extractNew.click();
      });

      // Wait for and handle the file chooser dialog
      const fileChooser = await fileChooserPromise;
      debugLog('File chooser appeared, setting file...');
      await fileChooser.setFiles('demo/data/pdf/example/10.5771__2699-1284-2024-3-149.pdf');
      debugLog('File set, waiting for upload completion...');

      // Wait for PDF upload completion
      debugLog('Captured console logs so far:', consoleLogs.length);
      if (DEBUG && consoleLogs.length > 0) {
        debugLog('Recent console messages:', consoleLogs.slice(-5).map(log => log.text || log.type));
      }

      // Wait for PDF upload completion with debugging
      const uploadLog = await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 10000);
      debugLog('Found PDF_UPLOAD_COMPLETED:', uploadLog);
      expect(uploadLog.value).toHaveProperty('originalFilename');
      expect(uploadLog.value).toHaveProperty('filename');

      // Wait for extraction options dialog to appear
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 10000);

      // Wait for the extraction options dialog to open
      await page.waitForSelector('sl-dialog[name="extractionOptions"][open]', { timeout: 5000 });

      // Fill out the extraction options dialog
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        // Set the extractor to llamore-gemini (which should be available based on the template)
        ui.extractionOptions.modelIndex.value = 'llamore-gemini';
        // Submit the dialog
        ui.extractionOptions.submit.click();
      });

      // Wait for extraction to complete (this can take time)
      const extractionLog = await waitForTestMessage(consoleLogs, 'EXTRACTION_COMPLETED', 60000);
      expect(extractionLog.value).toHaveProperty('resultHash');

      // Wait for the extracted document to be shown in the editor
      await waitForTestMessage(consoleLogs, 'XML_EDITOR_DOCUMENT_LOADED', 10000);

      // Get initial state from extraction completion log
      const initialXmlState = extractionLog.value.resultHash;
      expect(initialXmlState).toBeTruthy();

      debugLog('PDF extraction test completed successfully');

    } finally {
      // cleanup
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });

});
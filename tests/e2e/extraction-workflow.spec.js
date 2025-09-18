/**
 * Extraction workflow end-to-end tests
 *
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/services.js
 * @testCovers server/api/files.py
 */

/** @import { namedElementsTree } from '../../app/src/ui.js' */

import { test, expect } from '@playwright/test';
import { setupTestConsoleCapture, waitForTestMessage } from '../../app/src/modules/test-logging.js';

// Configuration from environment variables
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

// Helper functions are now imported from test-logging.js

test.describe('Extraction Workflow', () => {

  test('should complete full extraction workflow from PDF to revision', async ({ page }) => {
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

    // Navigate to application
    await page.goto(E2E_BASE_URL);

    // Wait for application to load and show login dialog
    await page.waitForSelector('sl-dialog[name="loginDialog"][open]', { timeout: 10000 });

    // Fast login without testing intermediary steps
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.username.value = 'testuser';
      ui.loginDialog.password.value = 'testpass';
      ui.loginDialog.submit.click();
    });

    // Wait for login to complete
    await page.waitForSelector('sl-dialog[name="loginDialog"]:not([open])', { timeout: 5000 });

    // Wait for UI to be fully ready
    await page.waitForTimeout(2000);

    // Click extract new button to open file selection dialog
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.toolbar.extractionActions.extractNew.click();
    });

    // Wait for file input to be created and handle file upload
    await page.waitForSelector('input[type="file"]', { timeout: 5000 });

    // Set the file for upload
    await page.setInputFiles('input[type="file"]', 'demo/data/pdf/example/10.5771__2699-1284-2024-3-149.pdf');

    // Wait for PDF upload completion
    const uploadLog = await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 10000);
    expect(uploadLog.value).toHaveProperty('originalFilename');
    expect(uploadLog.value).toHaveProperty('filename');

    // Wait for extraction to complete (this can take time)
    const extractionLog = await waitForTestMessage(consoleLogs, 'EXTRACTION_COMPLETED', 60000);
    expect(extractionLog.value).toHaveProperty('resultHash');

    // Wait for the extracted document to be shown in the editor
    await waitForTestMessage(consoleLogs, 'XML_EDITOR_DOCUMENT_LOADED', 10000);

    // Get initial state from extraction completion log
    const initialXmlState = extractionLog.value.resultHash;
    expect(initialXmlState).toBeTruthy();

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

    // Check that state.xml has changed to the new version
    const newXmlState = newVersionLog.value.newHash;
    expect(newXmlState).toBeTruthy();
    expect(newXmlState).not.toBe(initialXmlState);
    expect(newVersionLog.value.oldHash).toBe(initialXmlState);

    // When the new version is loaded, click save revision button
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
    const revisionLog = await waitForTestMessage(consoleLogs, 'REVISION_SAVED', 10000);
    expect(revisionLog.value).toHaveProperty('changeDescription');
    expect(revisionLog.value.changeDescription).toBe('E2E test revision description');

    // Wait for verification that revision exists in XML document
    const xmlVerificationLog = await waitForTestMessage(consoleLogs, 'REVISION_IN_XML_VERIFIED', 5000);
    expect(xmlVerificationLog.value).toHaveProperty('changeDescription', 'E2E test revision description');
    expect(xmlVerificationLog.value).toHaveProperty('xmlContainsRevision', true);

    console.log('Extraction workflow test completed successfully');
  });
});
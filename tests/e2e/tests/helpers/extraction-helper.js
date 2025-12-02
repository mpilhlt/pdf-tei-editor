/**
 * E2E test extraction helper functions
 */

import { waitForTestMessage } from './test-logging.js';

// Enable debug output only when E2E_DEBUG environment variable is set
const DEBUG = process.env.E2E_DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};

/**
 * Performs PDF extraction workflow
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {any[]} consoleLogs - Console logs array for capturing test messages
 * @param {string} pdfFilePath - Path to PDF file to extract
 * @param {string} extractorModel - Extractor model to use (default: 'llamore-gemini')
 */
export async function performPdfExtraction(page, consoleLogs, pdfFilePath = 'tests/e2e/fixtures/pdf/test-document.pdf', extractorModel = 'llamore-gemini') {
  // Set up file input handling before clicking the button
  const fileChooserPromise = page.waitForEvent('filechooser');

  // Click extract new button to open file selection dialog
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.toolbar.extractionActions.extractNew.click();
  });

  // Wait for and handle the file chooser dialog
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(pdfFilePath);

  // Wait for PDF upload completion
  await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 10000);

  // Wait for extraction options dialog to appear
  await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 10000);

  // Wait for the extraction options dialog to open
  await page.waitForSelector('sl-dialog[name="extractionOptions"][open]', { timeout: 5000 });

  // Fill out the extraction options dialog
  await page.evaluate((model) => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    // Set the extractor model
    ui.extractionOptions.modelIndex.value = model;
    // Submit the dialog
    ui.extractionOptions.submit.click();
  }, extractorModel);

  // Wait for extraction to complete (this can take time)
  const extractionLog = await waitForTestMessage(consoleLogs, 'EXTRACTION_COMPLETED', 60000);

  // Wait for the extracted document to be shown in the editor
  await waitForTestMessage(consoleLogs, 'XML_EDITOR_DOCUMENT_LOADED', 10000);

  return extractionLog;
}

/**
 * @typedef LoadResult
 * @property {Boolean} success
 * @property {String} reason
 * @property {{xml,pdf}} [loadParams]
 */

/**
 * Selects the first available PDF and XML documents by simulating user clicks
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @return {Promise<LoadResult>}
 */
export async function selectFirstDocuments(page) {
  // Debug: Check what documents are available first
  const beforeSelection = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    const pdfOptions = ui.toolbar.pdf.querySelectorAll('sl-option');
    const xmlOptions = ui.toolbar.xml.querySelectorAll('sl-option');

    return {
      pdfOptionsCount: pdfOptions.length,
      xmlOptionsCount: xmlOptions.length,
      pdfOptionValues: Array.from(pdfOptions).map(opt => opt.value),
      xmlOptionValues: Array.from(xmlOptions).map(opt => opt.value),
      currentPdfValue: ui.toolbar.pdf.value,
      currentXmlValue: ui.toolbar.xml.value
    };
  });
  debugLog('Before selection:', beforeSelection);

  // Try to select the first PDF by setting value directly (bypass the programmatic check)
  const pdfSelected = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;

    const pdfOptions = ui.toolbar.pdf.querySelectorAll('sl-option');
    if (pdfOptions.length > 0) {
      const firstPdfValue = pdfOptions[0].value;
      console.log('Attempting to select PDF:', firstPdfValue);

      // Try direct value assignment
      ui.toolbar.pdf.value = firstPdfValue;

      // Try to force the change event with proper event details
      const changeEvent = new CustomEvent('sl-change', {
        detail: { value: firstPdfValue },
        bubbles: true
      });
      ui.toolbar.pdf.dispatchEvent(changeEvent);

      return { success: true, selectedValue: firstPdfValue };
    }
    return { success: false, reason: 'No PDF options available' };
  });
  debugLog('PDF selection result:', pdfSelected);

  // Wait for PDF selection to process
  await page.waitForTimeout(2000);

  // Check state after PDF selection and select XML
  const xmlSelected = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    const xmlOptions = ui.toolbar.xml.querySelectorAll('sl-option');

    const beforeXml = {
      pdfValue: ui.toolbar.pdf.value,
      xmlValue: ui.toolbar.xml.value,
      xmlOptionsCount: xmlOptions.length,
      xmlOptionValues: Array.from(xmlOptions).map(opt => opt.value)
    };

    // Try to select the first XML if available
    if (xmlOptions.length > 0) {
      const firstXmlValue = xmlOptions[0].value;
      console.log('Attempting to select XML:', firstXmlValue);

      // Try direct value assignment
      ui.toolbar.xml.value = firstXmlValue;

      // Try to force the change event
      const changeEvent = new CustomEvent('sl-change', {
        detail: { value: firstXmlValue },
        bubbles: true
      });
      ui.toolbar.xml.dispatchEvent(changeEvent);

      return {
        success: true,
        selectedValue: firstXmlValue,
        before: beforeXml
      };
    }
    return {
      success: false,
      reason: 'No XML options available',
      before: beforeXml
    };
  });
  debugLog('XML selection result:', xmlSelected);

  // Wait for XML selection to process
  await page.waitForTimeout(1000);

  // Actually load the selected documents to trigger proper state updates
  const loadResult = await page.evaluate(async () => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    const services = /** @type {any} */(window).services;

    // Get the selected values
    const pdfValue = ui.toolbar.pdf.value;
    const xmlValue = ui.toolbar.xml.value;

    if (pdfValue || xmlValue) {
      // Call the load function through services
      const loadParams = {};
      if (pdfValue) loadParams.pdf = pdfValue;
      if (xmlValue) loadParams.xml = xmlValue;

      if (services && services.load) {
        try {
          await services.load(loadParams);
          return { success: true, loadParams };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      } else {
        return { success: false, reason: 'services.load not available' };
      }
    }
    return { success: false, reason: 'no files to load' };
  });
  debugLog('Load result:', loadResult);
  return loadResult;
}
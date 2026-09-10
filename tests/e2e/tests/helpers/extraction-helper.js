/**
 * E2E test extraction helper functions
 */

import { waitForTestMessage } from './test-logging.js';
import { debugLog } from './debug-helpers.js';

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
 * @property {String} [reason]
 * @property {{xml: string, pdf: string}} [loadParams]
 */

/**
 * Selects the first available PDF and XML documents by simulating user clicks
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @return {Promise<LoadResult>}
 */
export async function selectFirstDocuments(page) {
  // Wait until the source-file (PDF) selectbox has been populated from fileData.
  // The load triggered further down clears and disables the selectboxes while it
  // runs, so every step below waits on an explicit condition instead of a fixed
  // timeout (the load is slower than any fixed delay we could safely pick).
  try {
    await page.waitForFunction(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return !ui.toolbar.pdf.disabled &&
        ui.toolbar.pdf.querySelectorAll('sl-option').length > 0;
    }, { timeout: 15000 });
  } catch (error) {
    return { success: false, reason: `PDF selectbox never populated: ${String(error)}` };
  }

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

  // Select the first PDF by simulating a genuine user interaction. Dispatching
  // sl-show first is required so the file-selection plugin's #userOpenedDropdown
  // guard lets the sl-change handler run; that handler loads the PDF together
  // with its gold TEI and updates application state.
  const pdfSelected = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;

    const pdfOptions = ui.toolbar.pdf.querySelectorAll('sl-option');
    if (pdfOptions.length === 0) {
      return { success: false, reason: 'No PDF options available' };
    }
    const firstPdfValue = pdfOptions[0].value;
    console.log('Attempting to select PDF:', firstPdfValue);

    ui.toolbar.pdf.dispatchEvent(new CustomEvent('sl-show', { bubbles: true }));
    ui.toolbar.pdf.value = firstPdfValue;
    ui.toolbar.pdf.dispatchEvent(new CustomEvent('sl-change', {
      detail: { value: firstPdfValue },
      bubbles: true
    }));

    return { success: true, selectedValue: firstPdfValue };
  });
  debugLog('PDF selection result:', pdfSelected);
  if (!pdfSelected.success) {
    return pdfSelected;
  }

  // Wait for the PDF selection load to finish: state.pdf reflects the selection
  // and the selectboxes have been re-enabled and repopulated.
  try {
    await page.waitForFunction((expectedPdf) => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      /** @type {any} */
      const app = /** @type {any} */(window).app;
      const state = app.getCurrentState();
      return state.pdf === expectedPdf && !ui.toolbar.pdf.disabled;
    }, pdfSelected.selectedValue, { timeout: 20000 });
  } catch (error) {
    return { success: false, reason: `PDF load did not complete: ${String(error)}` };
  }

  // The PDF handler loads the gold TEI automatically. If no XML ended up loaded
  // (e.g. the source has no gold artifact), pick the first version explicitly.
  const xmlSelected = await page.evaluate(async () => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    /** @type {any} */
    const app = /** @type {any} */(window).app;

    if (app.getCurrentState().xml) {
      return { success: true, selectedValue: app.getCurrentState().xml, alreadyLoaded: true };
    }

    const xmlOptions = ui.toolbar.xml.querySelectorAll('sl-option');
    if (xmlOptions.length === 0) {
      return { success: false, reason: 'No XML options available after loading PDF' };
    }
    const firstXmlValue = xmlOptions[0].value;
    console.log('Attempting to select XML:', firstXmlValue);

    ui.toolbar.xml.dispatchEvent(new CustomEvent('sl-show', { bubbles: true }));
    ui.toolbar.xml.value = firstXmlValue;
    ui.toolbar.xml.dispatchEvent(new CustomEvent('sl-change', {
      detail: { value: firstXmlValue },
      bubbles: true
    }));

    return { success: true, selectedValue: firstXmlValue };
  });
  debugLog('XML selection result:', xmlSelected);
  if (!xmlSelected.success) {
    return xmlSelected;
  }

  // Wait for the XML to be loaded into application state.
  try {
    await page.waitForFunction((expectedXml) => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      /** @type {any} */
      const app = /** @type {any} */(window).app;
      const state = app.getCurrentState();
      return Boolean(state.xml) && !ui.toolbar.xml.disabled &&
        (expectedXml ? state.xml === expectedXml : true);
    }, xmlSelected.alreadyLoaded ? null : xmlSelected.selectedValue, { timeout: 20000 });
  } catch (error) {
    return { success: false, reason: `XML load did not complete: ${String(error)}` };
  }

  const loadParams = await page.evaluate(() => {
    /** @type {any} */
    const app = /** @type {any} */(window).app;
    const state = app.getCurrentState();
    return { pdf: state.pdf, xml: state.xml };
  });
  debugLog('Load result:', { success: true, loadParams });

  return { success: true, loadParams };
}
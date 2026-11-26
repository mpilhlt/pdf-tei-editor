/**
 * PDFs of a document (#944): text recognition creates a new PDF of the document; the versions
 * attached to the original PDF stay attached to it and are shown with it, copies of such a version
 * too. Without a gold version, the newest PDF is the canonical PDF that lists the document.
 *
 * Requires an available OCR engine (Tesseract installed); skipped otherwise.
 *
 * @testCovers app/src/plugins/services.js
 * @testCovers app/src/modules/file-data-utils.js
 * @testCovers fastapi_app/routers/ocr.py
 * @testCovers fastapi_app/lib/repository/file_repository.py
 */

import fs from 'fs';
import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

const SCANNED_PDF = 'tests/e2e/fixtures/pdf/scanned-document.pdf';

/**
 * A minimal TEI document
 * @param {string} body - Text of the body
 * @returns {string}
 */
function tei(body) {
  return `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>PDF versions test</title></titleStmt><publicationStmt><p/></publicationStmt><sourceDesc><p/></sourceDesc></fileDesc></teiHeader><text><body><p>${body}</p></body></text></TEI>`;
}

test.describe('PDFs of a document after OCR', () => {
  test('versions made before OCR are shown with the original PDF', async ({ page }) => {
    test.setTimeout(120000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, [
      'Failed to load resource.*401.*UNAUTHORIZED',
      'Failed to load autocomplete data',
      'api/validate/autocomplete-data.*400.*BAD REQUEST'
    ]);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      const engines = await page.evaluate(() => /** @type {any} */(window).client.apiClient.ocrEngines());
      test.skip(engines.length === 0, 'No OCR engine available (Tesseract not installed)');

      // Upload a copy of the scanned PDF with unique content, so that no other test shares it
      const unique = `pdf-versions-${Date.now()}`;
      const buffer = Buffer.concat([fs.readFileSync(SCANNED_PDF), Buffer.from(`\n%${unique}\n`)]);
      const fileChooserPromise = page.waitForEvent('filechooser');
      const uploadPromise = page.evaluate(() => /** @type {any} */(window).client.uploadFile());
      await (await fileChooserPromise).setFiles({ name: `${unique}.pdf`, mimeType: 'application/pdf', buffer });
      const upload = await uploadPromise;
      const pdfId = upload.filename;
      expect(pdfId).toBeTruthy();

      // A version made from the original PDF
      const { docId, v1 } = await page.evaluate(async ({ pdfId, xml }) => {
        const client = /** @type {any} */(window).client;
        const list = await client.apiClient.filesList();
        const group = list.files.find((/** @type {any} */ f) => f.source?.id === pdfId);
        const saved = await client.apiClient.filesSave({ xml_string: xml, file_id: group.doc_id, new_version: true });
        await client.apiClient.filesReleaseLock({ file_id: saved.file_id });
        return { docId: group.doc_id, v1: saved.file_id };
      }, { pdfId, xml: tei('first version') });
      expect(docId).toBeTruthy();

      // Text recognition creates a new PDF of the document
      const result = await page.evaluate(async ({ pdfId, engine }) => {
        const api = /** @type {any} */(window).client.apiClient;
        let job = await api.ocr({ stable_id: pdfId, engine: engine.id, languages: engine.default_languages, options: {}, rebuild: false });
        while (job.status === 'queued' || job.status === 'running') {
          await new Promise(resolve => setTimeout(resolve, 500));
          job = await api.ocrJob(job.job_id);
        }
        return job;
      }, { pdfId, engine: engines[0] });
      expect(result.status, result.error).toBe('done');
      expect(result.result.changed).toBe(true);
      expect(result.result.source_stable_id).toBe(pdfId);
      const ocrPdfId = result.result.stable_id;
      expect(ocrPdfId).toBeTruthy();
      expect(ocrPdfId).not.toBe(pdfId);

      // A copy of the first version stays with the original PDF
      const { v2, artifacts, sources, pdfs } = await page.evaluate(async ({ v1, xml, docId }) => {
        const client = /** @type {any} */(window).client;
        const saved = await client.apiClient.filesSave({ xml_string: xml, file_id: v1, new_version: true });
        await client.apiClient.filesReleaseLock({ file_id: saved.file_id });
        await /** @type {any} */(window).app.getDependency('file-selection').reload({ refresh: true });
        const list = await client.apiClient.filesList();
        const groups = list.files.filter((/** @type {any} */ f) => f.doc_id === docId);
        return {
          v2: saved.file_id,
          artifacts: Object.fromEntries(groups.flatMap((/** @type {any} */ g) => g.artifacts).map((/** @type {any} */ a) => [a.id, a.pdf_id ?? null])),
          sources: groups.map((/** @type {any} */ g) => g.source.id),
          pdfs: groups.flatMap((/** @type {any} */ g) => (g.pdfs || []).map((/** @type {any} */ p) => p.id))
        };
      }, { v1, xml: tei('copy of the first version'), docId });
      // the document is listed once, by its newest PDF (there is no gold version), with both PDFs
      expect(sources).toEqual([ocrPdfId]);
      expect(pdfs).toEqual([pdfId, ocrPdfId]);
      expect(artifacts[v1]).toBe(pdfId);
      expect(artifacts[v2]).toBe(pdfId);

      // Loading the new PDF alone shows it ...
      consoleLogs.length = 0;
      await page.evaluate((id) => /** @type {any} */(window).app.getDependency('services').load({ pdf: id }), ocrPdfId);
      expect((await waitForTestMessage(consoleLogs, 'PDF_SHOWN', 15000)).value).toEqual({ pdf: ocrPdfId });

      // ... loading a version made before OCR shows the original PDF, which becomes the open PDF
      consoleLogs.length = 0;
      await page.evaluate((v1) => /** @type {any} */(window).app.getDependency('services').load({ xml: v1 }), v1);
      expect((await waitForTestMessage(consoleLogs, 'PDF_SHOWN', 15000)).value).toEqual({ pdf: pdfId });
      expect(await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().pdf)).toBe(pdfId);
      await page.waitForFunction(() => /** @type {any} */(window).app.getDependency('pdfviewer').pdfDoc?.numPages > 0, null, { timeout: 15000 });
      // the file selection shows the document of the open PDF
      expect(await page.evaluate(() => /** @type {any} */(window).ui.toolbar.pdf.value)).toBe(ocrPdfId);

      // Switching to the new PDF alone again shows it
      consoleLogs.length = 0;
      await page.evaluate((id) => /** @type {any} */(window).app.getDependency('services').load({ pdf: id }), ocrPdfId);
      expect((await waitForTestMessage(consoleLogs, 'PDF_SHOWN', 15000)).value).toEqual({ pdf: ocrPdfId });
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});

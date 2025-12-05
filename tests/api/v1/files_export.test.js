/**
 * API integration tests for /api/v1/export
 *
 * @testCovers fastapi_app/routers/files_export.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, API_BASE } from '../helpers/test-auth.js';
import AdmZip from 'adm-zip';

describe('File Export API', () => {
  let sessionId;

  test('should login as admin', async () => {
    const result = await login('admin', 'admin');
    sessionId = result.sessionId;
    assert.ok(sessionId, 'Should get session ID');
  });

  test('GET /api/v1/export - should require authentication', async () => {
    const response = await fetch(`${API_BASE}/export`, {
      method: 'GET'
    });
    assert.strictEqual(response.status, 401, 'Should return 401 without session');
  });

  test('GET /api/v1/export - should export all files as zip', async () => {
    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 200, 'Should return 200 OK');
    assert.ok(response.headers.get('content-type').includes('application/zip'), 'Should return zip file');

    const buffer = await response.arrayBuffer();
    assert.ok(buffer.byteLength > 0, 'Should have non-empty response');

    // Verify it's a valid zip file
    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();
    assert.ok(zipEntries.length > 0, 'Zip should contain files');

    console.log(`Exported ${zipEntries.length} files`);
  });

  test.skip('GET /api/v1/export - should filter by collection', async () => {
    // TEMPORARILY DISABLED: Test isolation issue - passes when run alone, fails in full suite
    // See dev/todo/re-enable-export-test.md for details
    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}&collections=default`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    const buffer = await response.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();
    assert.ok(zipEntries.length > 0, 'Zip should contain files');

    // All files should be under default directory when group_by=collection (default)
    const collectionFiles = zipEntries.filter(entry =>
      entry.entryName.startsWith('default/')
    );
    assert.ok(collectionFiles.length > 0, 'Should have files in default directory');
  });

  test('GET /api/v1/export - should support group_by parameter', async () => {
    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}&group_by=type`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    const buffer = await response.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();

    // Should have pdf/ and tei/ directories when grouped by type
    const hasPdfDir = zipEntries.some(entry => entry.entryName.startsWith('pdf/'));
    const hasTeiDir = zipEntries.some(entry => entry.entryName.startsWith('tei/'));

    assert.ok(hasPdfDir || hasTeiDir, 'Should have type-based directories (pdf/ or tei/)');
  });

  test('GET /api/v1/export - should reject invalid group_by', async () => {
    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}&group_by=invalid`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 400, 'Should return 400 for invalid group_by');
  });

  test('GET /api/v1/export - should only export PDFs with matching gold TEI files', async () => {
    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}&group_by=type`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    const buffer = await response.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();

    // Extract PDFs and TEI files
    const pdfFiles = zipEntries.filter(entry => entry.entryName.startsWith('pdf/') && entry.entryName.endsWith('.pdf'));
    const teiFiles = zipEntries.filter(entry => entry.entryName.startsWith('tei/') && entry.entryName.endsWith('.tei.xml'));

    // Extract doc_ids from filenames
    const pdfDocIds = pdfFiles.map(entry => {
      const filename = entry.entryName.split('/')[1];
      // Remove .pdf extension to get doc_id
      return filename.replace(/\.pdf$/, '');
    });

    const teiDocIds = teiFiles.map(entry => {
      const filename = entry.entryName.split('/')[1];
      // Remove .tei.xml extension to get doc_id (with optional variant)
      // Pattern: doc_id.tei.xml or doc_id.variant.tei.xml
      const withoutExt = filename.replace(/\.tei\.xml$/, '');
      // Since doc_ids can contain dots, we can't reliably split on dots
      // Instead, we'll match each PDF by checking if the TEI filename starts with the PDF doc_id
      return withoutExt;
    });

    console.log('PDF doc_ids:', pdfDocIds);
    console.log('TEI doc_ids:', teiDocIds);

    // Every PDF should have at least one matching TEI file
    // TEI filename can be either doc_id or doc_id.variant
    for (const pdfDocId of pdfDocIds) {
      const hasTei = teiDocIds.some(teiId =>
        teiId === pdfDocId || teiId.startsWith(pdfDocId + '.')
      );
      assert.ok(hasTei, `PDF ${pdfDocId}.pdf should have a matching gold TEI file`);
    }

    console.log(`Verified ${pdfDocIds.length} PDFs all have matching gold TEI files`);
  });

  test('GET /api/v1/export - should filter PDFs by variant when variant filter is applied', async () => {
    // Export with a test variant filter (use 'grobid' as common variant)
    const testVariant = 'grobid';
    console.log(`Testing variant filter with: ${testVariant}`);

    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}&variants=${testVariant}&group_by=type`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    const buffer = await response.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();

    // Extract PDFs and TEI files
    const pdfFiles = zipEntries.filter(entry => entry.entryName.startsWith('pdf/') && entry.entryName.endsWith('.pdf'));
    const teiFiles = zipEntries.filter(entry => entry.entryName.startsWith('tei/') && entry.entryName.endsWith('.tei.xml'));

    if (teiFiles.length === 0) {
      console.log(`No TEI files with variant ${testVariant}, test passes (correct filtering)`);
      assert.strictEqual(pdfFiles.length, 0, 'Should not export PDFs without matching TEI variant');
      return;
    }

    // All TEI files should match the variant filter
    for (const teiEntry of teiFiles) {
      const filename = teiEntry.entryName.split('/')[1];
      // Filename should contain the variant: doc_id.variant.tei.xml
      assert.ok(
        filename.includes(`.${testVariant}.`),
        `TEI file ${filename} should contain variant ${testVariant}`
      );
    }

    // Extract doc_ids from filtered TEI files
    const teiDocIds = teiFiles.map(entry => {
      const filename = entry.entryName.split('/')[1];
      const withoutExt = filename.replace(/\.tei\.xml$/, '');
      // Remove variant suffix to get doc_id
      const parts = withoutExt.split('.');
      // Variant is last part, everything else is doc_id
      return parts.slice(0, -1).join('.');
    });

    // Extract doc_ids from PDFs
    const pdfDocIds = pdfFiles.map(entry => {
      const filename = entry.entryName.split('/')[1];
      return filename.replace(/\.pdf$/, '');
    });

    // Every PDF should have a matching TEI with the specified variant
    for (const pdfDocId of pdfDocIds) {
      const hasTei = teiDocIds.includes(pdfDocId);
      assert.ok(hasTei, `PDF ${pdfDocId}.pdf should have a matching gold TEI file with variant ${testVariant}`);
    }

    // No PDFs should be exported without a matching TEI of the specified variant
    const uniquePdfDocIds = new Set(pdfDocIds);
    const uniqueTeiDocIds = new Set(teiDocIds);
    assert.deepStrictEqual(
      uniquePdfDocIds,
      uniqueTeiDocIds,
      'PDFs and TEI files should have matching doc_ids when variant filter is applied'
    );

    console.log(`Verified ${pdfDocIds.length} PDFs all have matching gold TEI files with variant ${testVariant}`);
  });

  test('GET /api/v1/export - should only export gold TEI files by default', async () => {
    const response = await fetch(`${API_BASE}/export?sessionId=${sessionId}&group_by=type`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    const buffer = await response.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const zipEntries = zip.getEntries();

    // Should NOT have versions/ directory (only gold files)
    const hasVersionsDir = zipEntries.some(entry => entry.entryName.startsWith('versions/'));
    assert.strictEqual(hasVersionsDir, false, 'Should not have versions/ directory (gold files only by default)');

    // All TEI files should be in tei/ directory (not versions/)
    const teiFiles = zipEntries.filter(entry => entry.entryName.endsWith('.tei.xml'));
    const allInTeiDir = teiFiles.every(entry => entry.entryName.startsWith('tei/'));
    assert.ok(allInTeiDir, 'All TEI files should be in tei/ directory (gold files)');

    console.log(`Verified all ${teiFiles.length} TEI files are gold standard`);
  });
});

/**
 * API tests for deleting a version together with its history
 * @testCovers fastapi_app/routers/files_delete.py
 * @testCovers fastapi_app/lib/repository/file_repository.py
 *
 * Lineage: gold -> a -> b -> c, and a -> d. Deleting c with its history removes c and b; a is
 * kept because d descends from it, gold is never removed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall, authenticatedRequest } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

/**
 * @param {string} docId
 * @param {number} n - number of change elements
 * @param {string} content - paragraph text
 */
const createTei = (docId, n, content) => `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Delete History Test ${docId}</title></titleStmt>
      <editionStmt><edition><idno type="fileref">${docId}</idno></edition></editionStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc>
        <p>Test</p>
        <application type="extractor"><label type="variant-id">delete-history-test</label></application>
      </sourceDesc>
    </fileDesc>
    <revisionDesc>
      ${Array.from({ length: n }, (_, i) => `<change when="2026-10-0${i + 1}T10:00:00Z" who="#reviewer" status="draft"><desc>Change ${i}</desc></change>`).join('')}
    </revisionDesc>
  </teiHeader>
  <text><body><div><p>${content}</p></div></body></text>
</TEI>`;

describe('Delete version history API tests', () => {
  let session = null;
  const docId = `test-delhist-${Math.random().toString(36).substring(2, 12)}`;
  /** @type {Record<string, string>} */
  const ids = {};

  /**
   * @param {string} fileId - file to save or copy from
   * @param {number} n
   * @param {string} content
   * @param {boolean} newVersion
   */
  async function save(fileId, n, content, newVersion) {
    const response = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: fileId, xml_string: createTei(docId, n, content), new_version: newVersion
    }, BASE_URL);
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', { file_id: response.file_id }, BASE_URL);
    return response.file_id;
  }

  async function artifactIds() {
    const list = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);
    const doc = list.files.find(f => f.doc_id === docId);
    return new Set(doc ? doc.artifacts.map(a => a.id) : []);
  }

  test('Setup: create the lineage', async () => {
    session = await login('reviewer', 'reviewer', BASE_URL);
    ids.gold = await save(docId, 1, 'Gold', false);
    ids.a = await save(ids.gold, 2, 'A', true);
    ids.b = await save(ids.a, 3, 'B', true);
    ids.c = await save(ids.b, 4, 'C', true);
    ids.d = await save(ids.a, 3, 'D', true);
    const artifacts = await artifactIds();
    for (const id of Object.values(ids)) assert.ok(artifacts.has(id), `${id} listed`);
  });

  test('a version that others were copied from is refused with 409', async () => {
    const response = await authenticatedRequest(session.sessionId, '/files/delete_history', 'POST', {
      file_id: ids.b, dry_run: true
    }, BASE_URL);
    assert.strictEqual(response.status, 409);
  });

  test('a gold standard is refused with 400', async () => {
    const response = await authenticatedRequest(session.sessionId, '/files/delete_history', 'POST', {
      file_id: ids.gold, dry_run: true
    }, BASE_URL);
    assert.strictEqual(response.status, 400);
  });

  test('a dry run lists the version and its exclusive ancestors without deleting', async () => {
    const result = await authenticatedApiCall(session.sessionId, '/files/delete_history', 'POST', {
      file_id: ids.c, dry_run: true
    }, BASE_URL);
    assert.deepStrictEqual(result, { files: [ids.c, ids.b], deleted: false });
    const artifacts = await artifactIds();
    assert.ok(artifacts.has(ids.c) && artifacts.has(ids.b));
  });

  test('deleting removes the exclusive history and keeps the shared ancestor', async () => {
    const result = await authenticatedApiCall(session.sessionId, '/files/delete_history', 'POST', {
      file_id: ids.c
    }, BASE_URL);
    assert.deepStrictEqual(result, { files: [ids.c, ids.b], deleted: true });
    const artifacts = await artifactIds();
    assert.ok(!artifacts.has(ids.c) && !artifacts.has(ids.b));
    assert.ok(artifacts.has(ids.a) && artifacts.has(ids.d) && artifacts.has(ids.gold));
  });

  test('deleting the last branch removes the ancestor up to gold', async () => {
    const result = await authenticatedApiCall(session.sessionId, '/files/delete_history', 'POST', {
      file_id: ids.d
    }, BASE_URL);
    assert.deepStrictEqual(result, { files: [ids.d, ids.a], deleted: true });
    const artifacts = await artifactIds();
    assert.ok(artifacts.has(ids.gold));
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', { files: [ids.gold] }, BASE_URL);
  });
});

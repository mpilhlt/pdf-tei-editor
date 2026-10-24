/**
 * API tests for frozen versions and the revision hash chain
 * @testCovers fastapi_app/routers/files_save.py
 * @testCovers fastapi_app/routers/files_locks.py
 * @testCovers fastapi_app/routers/files_list.py
 * @testCovers fastapi_app/lib/utils/revision_hash.py
 *
 * A version that another version was copied from is frozen: saves and locks are refused, the
 * file list marks it `is_frozen`, and deleting the copy unfreezes it again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall, authenticatedRequest } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Documents without PDF are listed with their first file as source; a variant makes the files
// appear as artifacts, which carry the freeze flags.

/**
 * @param {string} docId
 * @param {string} changes - change elements
 * @param {string} content - paragraph text
 */
const createTei = (docId, changes, content) => `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Freeze Test ${docId}</title></titleStmt>
      <editionStmt><edition><idno type="fileref">${docId}</idno></edition></editionStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc>
        <p>Test</p>
        <application type="extractor"><label type="variant-id">freeze-test</label></application>
      </sourceDesc>
    </fileDesc>
    <revisionDesc>
      ${changes}
    </revisionDesc>
  </teiHeader>
  <text><body><div><p>${content}</p></div></body></text>
</TEI>`;

const CHANGE_GOLD = '<change when="2026-10-01T10:00:00Z" who="#reviewer" status="draft"><desc>Gold</desc></change>';
const CHANGE_COPY = '<change when="2026-10-02T10:00:00Z" who="#annotator" status="draft"><desc>Copy</desc></change>';

/**
 * @param {string} sessionId
 * @param {string} docId
 */
async function findArtifacts(sessionId, docId) {
  const list = await authenticatedApiCall(sessionId, '/files/list', 'GET', null, BASE_URL);
  const doc = list.files.find(f => f.doc_id === docId);
  return doc ? doc.artifacts : [];
}

/**
 * @param {string} sessionId
 * @param {string} fileId
 */
async function releaseLock(sessionId, fileId) {
  await authenticatedApiCall(sessionId, '/files/release_lock', 'POST', { file_id: fileId }, BASE_URL);
}

describe('Version freeze API tests', () => {
  let reviewerSession = null;
  let annotatorSession = null;
  const docId = `test-freeze-${Math.random().toString(36).substring(2, 12)}`;
  const state = { goldId: null, copyId: null };

  test('Setup: login', async () => {
    reviewerSession = await login('reviewer', 'reviewer', BASE_URL);
    annotatorSession = await login('annotator', 'annotator', BASE_URL);
    assert.ok(reviewerSession?.sessionId && annotatorSession?.sessionId);
  });

  test('saving a revision stamps a hash into the last header change', async () => {
    const response = await authenticatedApiCall(reviewerSession.sessionId, '/files/save', 'POST', {
      file_id: docId, xml_string: createTei(docId, CHANGE_GOLD, 'Gold text'), new_version: false
    }, BASE_URL);
    state.goldId = response.file_id;
    await releaseLock(reviewerSession.sessionId, state.goldId);

    const xml = await authenticatedApiCall(reviewerSession.sessionId, `/api/files/${state.goldId}`, 'GET', null, BASE_URL);
    assert.match(xml, /<change xml:id="h-[0-9a-f]{16}" when="2026-10-01T10:00:00Z"/);
  });

  test('a new version records its parent and freezes the source', async () => {
    const response = await authenticatedApiCall(annotatorSession.sessionId, '/files/save', 'POST', {
      file_id: state.goldId, xml_string: createTei(docId, CHANGE_GOLD + CHANGE_COPY, 'Copied text'), new_version: true
    }, BASE_URL);
    state.copyId = response.file_id;
    await releaseLock(annotatorSession.sessionId, state.copyId);

    const artifacts = await findArtifacts(reviewerSession.sessionId, docId);
    const gold = artifacts.find(a => a.id === state.goldId);
    const copy = artifacts.find(a => a.id === state.copyId);
    assert.strictEqual(copy.parent_id, state.goldId);
    assert.strictEqual(gold.is_frozen, true);
    assert.strictEqual(copy.is_frozen, false);

    // the copy gets the source's hash back for the inherited change, and a new one for its own
    const xml = await authenticatedApiCall(annotatorSession.sessionId, `/api/files/${state.copyId}`, 'GET', null, BASE_URL);
    const goldXml = await authenticatedApiCall(reviewerSession.sessionId, `/api/files/${state.goldId}`, 'GET', null, BASE_URL);
    const goldHash = /<change xml:id="(h-[0-9a-f]{16})"/.exec(goldXml)?.[1];
    const hashes = [...xml.matchAll(/<change xml:id="(h-[0-9a-f]{16})"/g)].map(m => m[1]);
    assert.strictEqual(hashes.length, 2);
    assert.strictEqual(hashes[0], goldHash);
    assert.notStrictEqual(hashes[1], goldHash);
  });

  test('saving a frozen version is refused with 409', async () => {
    const response = await authenticatedRequest(reviewerSession.sessionId, '/files/save', 'POST', {
      file_id: state.goldId, xml_string: createTei(docId, CHANGE_GOLD, 'Changed gold'), new_version: false
    }, BASE_URL);
    assert.strictEqual(response.status, 409);
  });

  test('locking a frozen version is refused with 403', async () => {
    const response = await authenticatedRequest(reviewerSession.sessionId, '/files/acquire_lock', 'POST', {
      file_id: state.goldId
    }, BASE_URL);
    assert.strictEqual(response.status, 403);
  });

  test('the copy can still be edited', async () => {
    const response = await authenticatedApiCall(annotatorSession.sessionId, '/files/save', 'POST', {
      file_id: state.copyId, xml_string: createTei(docId, CHANGE_GOLD + CHANGE_COPY, 'Edited copy'), new_version: false
    }, BASE_URL);
    assert.strictEqual(response.status, 'saved');
    await releaseLock(annotatorSession.sessionId, state.copyId);
  });

  test('deleting the copy unfreezes the source', async () => {
    await authenticatedApiCall(reviewerSession.sessionId, '/files/delete', 'POST', { files: [state.copyId] }, BASE_URL);
    state.copyId = null;
    const artifacts = await findArtifacts(reviewerSession.sessionId, docId);
    assert.strictEqual(artifacts.find(a => a.id === state.goldId).is_frozen, false);

    const response = await authenticatedApiCall(reviewerSession.sessionId, '/files/save', 'POST', {
      file_id: state.goldId, xml_string: createTei(docId, CHANGE_GOLD, 'Gold edited again'), new_version: false
    }, BASE_URL);
    assert.strictEqual(response.status, 'saved');
    await releaseLock(reviewerSession.sessionId, state.goldId);
  });

  test('Cleanup: delete test files', async () => {
    const files = [state.goldId, state.copyId].filter(Boolean);
    try {
      await authenticatedApiCall(reviewerSession.sessionId, '/files/delete', 'POST', { files }, BASE_URL);
    } catch (error) {
      logger.warn(`Cleanup error (non-critical): ${error.message}`);
    }
  });
});

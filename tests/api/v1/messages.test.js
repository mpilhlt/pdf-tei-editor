/**
 * API tests for messages (reviews and comments addressed to users), replies to comment threads and
 * reviews and comments saved into files the user cannot edit
 * @testCovers fastapi_app/routers/messages.py
 * @testCovers fastapi_app/routers/files_comments.py
 * @testCovers fastapi_app/routers/files_save.py
 * @testCovers fastapi_app/lib/messages/service.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall, authenticatedRequest } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

/**
 * A TEI document of the reviewer with a comment thread mentioning the annotator and a not-OK
 * mark of the annotator.
 * @param {string} docId
 * @param {string} title
 * @returns {string}
 */
const createTei = (docId, title = 'Messages Test') => `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>${title} ${docId}</title>
        <respStmt>
          <persName xml:id="reviewer">Reviewer</persName>
          <resp>Annotator</resp>
        </respStmt>
        <respStmt>
          <persName xml:id="annotator">Annotator</persName>
          <resp>Reviewer</resp>
        </respStmt>
      </titleStmt>
      <editionStmt><edition><idno type="fileref">${docId}</idno></edition></editionStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc><p>Test</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <standOff>
    <listAnnotation type="unit-review" subtype="fp-sha256-8-v1">
      <annotation xml:id="ur-annotator" motivation="assessing" target="#xpath(//text)" resp="#annotator">
        <revisionDesc><change when="2026-10-24T09:00:00Z"/></revisionDesc>
        <note type="not-ok" n="0badc0de">Wrong year</note>
      </annotation>
    </listAnnotation>
    <listAnnotation type="unit-comment" subtype="fp-sha256-8-v1">
      <annotation xml:id="uc-msg001" motivation="commenting" target="#xpath(/TEI/text/body/listBibl/bibl[1])" resp="#reviewer">
        <revisionDesc>
          <change when="2026-10-24T10:00:00Z" who="#reviewer"/>
        </revisionDesc>
        <note type="comment">@annotator please check the year</note>
      </annotation>
    </listAnnotation>
  </standOff>
  <text><body><listBibl><bibl>Smith 2019</bibl><bibl>Doe 2020</bibl></listBibl></body></text>
</TEI>`;

/**
 * Polls the message list until a predicate holds (the index is updated in the background).
 * @param {string} sessionId
 * @param {(items: any[]) => boolean} predicate
 * @returns {Promise<any>} The last list response
 */
async function waitForMessages(sessionId, predicate) {
  let response = null;
  for (let i = 0; i < 40; i++) {
    response = await authenticatedApiCall(sessionId, '/messages', 'GET', null, BASE_URL);
    if (predicate(response.items)) return response;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return response;
}

describe('Messages API tests', () => {
  let reviewer = null;
  let annotator = null;
  const docId = `test-messages-${Math.random().toString(36).substring(2, 12)}`;
  const state = { fileId: null, replyId: null, originalXml: null };

  test('Setup: login and save a document with a comment and a review mark', async () => {
    reviewer = await login('reviewer', 'reviewer', BASE_URL);
    annotator = await login('annotator', 'annotator', BASE_URL);
    state.originalXml = createTei(docId);
    const response = await authenticatedApiCall(reviewer.sessionId, '/files/save', 'POST', {
      file_id: docId, xml_string: state.originalXml, new_version: false
    }, BASE_URL);
    state.fileId = response.file_id;
    await authenticatedApiCall(reviewer.sessionId, '/files/release_lock', 'POST', { file_id: state.fileId }, BASE_URL);
  });

  test('the mentioned user receives the comment, the owner the not-OK mark', async () => {
    const forAnnotator = await waitForMessages(annotator.sessionId, items => items.some(m => m.key === `c:${docId}:uc-msg001`));
    const comment = forAnnotator.items.find(m => m.key === `c:${docId}:uc-msg001`);
    assert.ok(comment, 'comment message for the annotator');
    assert.strictEqual(comment.reason, 'mention');
    assert.strictEqual(comment.stable_id, state.fileId);
    assert.strictEqual(comment.thread_id, 'uc-msg001');
    assert.strictEqual(comment.excerpt, 'Smith 2019');
    assert.strictEqual(comment.read, false);

    const forReviewer = await waitForMessages(reviewer.sessionId, items => items.some(m => m.key.startsWith(`r:${docId}:`)));
    const review = forReviewer.items.find(m => m.key.startsWith(`r:${docId}:`));
    assert.ok(review, 'review message for the owner');
    assert.strictEqual(review.reason, 'owner');
    assert.strictEqual(review.text, 'Wrong year');
    assert.strictEqual(review.author, 'annotator');
  });

  test('marking a message read lowers the count, unread raises it again', async () => {
    const before = await authenticatedApiCall(annotator.sessionId, '/messages/count', 'GET', null, BASE_URL);
    const read = await authenticatedApiCall(annotator.sessionId, '/messages/read', 'POST', { keys: [`c:${docId}:uc-msg001`], read: true }, BASE_URL);
    assert.strictEqual(read.unread, before.unread - 1);
    const unread = await authenticatedApiCall(annotator.sessionId, '/messages/read', 'POST', { keys: [`c:${docId}:uc-msg001`], read: false }, BASE_URL);
    assert.strictEqual(unread.unread, before.unread);
    const filtered = await authenticatedApiCall(annotator.sessionId, '/messages?status=unread&kind=comment', 'GET', null, BASE_URL);
    assert.ok(filtered.items.every(m => m.key.startsWith('c:') && !m.read));
  });

  test('a user who cannot edit the file can reply to the thread', async () => {
    const response = await authenticatedApiCall(annotator.sessionId, `/files/${state.fileId}/comments/uc-msg001/replies`, 'POST', {
      text: 'The year is 2019.'
    }, BASE_URL);
    assert.strictEqual(response.thread_id, 'uc-msg001');
    assert.match(response.comment_id, /^uc-[0-9a-z]{6}$/);
    state.replyId = response.comment_id;

    const xml = await authenticatedApiCall(reviewer.sessionId, `/api/files/${state.fileId}`, 'GET', null, BASE_URL);
    assert.ok(xml.includes(`xml:id="${state.replyId}" motivation="replying" target="#uc-msg001" resp="#annotator"`));
    assert.ok(xml.includes('The year is 2019.'));

    // the thread author receives the reply
    const forReviewer = await waitForMessages(reviewer.sessionId, items => items.some(m => m.key === `c:${docId}:${state.replyId}`));
    const reply = forReviewer.items.find(m => m.key === `c:${docId}:${state.replyId}`);
    assert.ok(reply, 'reply message for the thread author');
    assert.strictEqual(reply.reason, 'thread-author');
  });

  test('saving over the file keeps the reply that the saved text lacks', async () => {
    const response = await authenticatedApiCall(reviewer.sessionId, '/files/save', 'POST', {
      file_id: state.fileId, xml_string: createTei(docId, 'Edited Messages Test'), new_version: false
    }, BASE_URL);
    await authenticatedApiCall(reviewer.sessionId, '/files/release_lock', 'POST', { file_id: response.file_id }, BASE_URL);
    const xml = await authenticatedApiCall(reviewer.sessionId, `/api/files/${state.fileId}`, 'GET', null, BASE_URL);
    assert.ok(xml.includes('Edited Messages Test'));
    assert.ok(xml.includes(`xml:id="${state.replyId}"`), 'reply kept');
  });

  test('replying to an unknown thread returns 404; users without role get 403', async () => {
    const missing = await authenticatedRequest(annotator.sessionId, `/files/${state.fileId}/comments/uc-nope00/replies`, 'POST', { text: 'x' }, BASE_URL);
    assert.strictEqual(missing.status, 404);
    const user = await login('user', 'user', BASE_URL);
    const forbidden = await authenticatedRequest(user.sessionId, `/files/${state.fileId}/comments/uc-msg001/replies`, 'POST', { text: 'x' }, BASE_URL);
    assert.strictEqual(forbidden.status, 403);
  });

  test('an annotator saves only their own comments into a file they cannot edit', async () => {
    const stored = await authenticatedApiCall(annotator.sessionId, `/api/files/${state.fileId}`, 'GET', null, BASE_URL);
    const comment = `<annotation xml:id="uc-ann001" motivation="commenting" target="#xpath(/TEI/text/body/listBibl/bibl[2])" resp="#annotator">
        <revisionDesc>
          <change when="2026-10-24T11:00:00Z" who="#annotator"/>
        </revisionDesc>
        <note type="comment">@reviewer is Doe right?</note>
      </annotation>
    </listAnnotation>
  </standOff>`;
    const review = `<annotation xml:id="ur-annotator2" motivation="assessing" target="#xpath(//text)" resp="#annotator">
        <revisionDesc><change when="2026-10-24T11:00:00Z"/></revisionDesc>
        <note type="ok">0badc0de</note>
      </annotation>
    </listAnnotation>`;
    const editorText = stored
      .replace(/<\/listAnnotation>\s*<\/standOff>/, comment)
      .replace('Doe 2020', 'Tampered 2020')
      .replace(/<\/listAnnotation>/, review);
    const response = await authenticatedApiCall(annotator.sessionId, `/files/${state.fileId}/standoff`, 'PUT', { xml_string: editorText }, BASE_URL);
    assert.strictEqual(response.status, 'saved');
    const xml = await authenticatedApiCall(reviewer.sessionId, `/api/files/${state.fileId}`, 'GET', null, BASE_URL);
    assert.ok(xml.includes('xml:id="uc-ann001"'), 'own comment saved');
    assert.ok(!xml.includes('Tampered'), 'text unchanged');
    assert.ok(!xml.includes('ur-annotator2'), 'annotators set no review marks');

    const again = await authenticatedApiCall(annotator.sessionId, `/files/${state.fileId}/standoff`, 'PUT', { xml_string: editorText }, BASE_URL);
    assert.strictEqual(again.status, 'unchanged');
    const user = await login('user', 'user', BASE_URL);
    const forbidden = await authenticatedRequest(user.sessionId, `/files/${state.fileId}/standoff`, 'PUT', { xml_string: editorText }, BASE_URL);
    assert.strictEqual(forbidden.status, 403);
  });

  test('rebuilding the index requires admin and keeps the read state', async () => {
    const denied = await authenticatedRequest(annotator.sessionId, '/messages/rebuild', 'POST', {}, BASE_URL);
    assert.strictEqual(denied.status, 403);
    await authenticatedApiCall(annotator.sessionId, '/messages/read', 'POST', { keys: [`c:${docId}:uc-msg001`], read: true }, BASE_URL);
    const admin = await login('admin', 'admin', BASE_URL);
    const rebuilt = await authenticatedApiCall(admin.sessionId, '/messages/rebuild', 'POST', {}, BASE_URL);
    assert.ok(rebuilt.files >= 1);
    const list = await authenticatedApiCall(annotator.sessionId, '/messages', 'GET', null, BASE_URL);
    const comment = list.items.find(m => m.key === `c:${docId}:uc-msg001`);
    assert.ok(comment);
    assert.strictEqual(comment.read, true);
  });

  test('read-all marks everything read', async () => {
    const result = await authenticatedApiCall(reviewer.sessionId, '/messages/read-all', 'POST', {}, BASE_URL);
    assert.strictEqual(result.unread, 0);
  });
});

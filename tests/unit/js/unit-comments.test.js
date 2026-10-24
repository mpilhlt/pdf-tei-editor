#!/usr/bin/env node

/**
 * Unit tests for the unit comments data model and the element anchors.
 * @testCovers app/src/modules/unit-comments.js
 * @testCovers app/src/modules/node-anchor.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import {
  readComments, serializeComments, buildThreads, addThread, addReply, setThreadStatus, editComment,
  deleteComment, newCommentId, threadStatus, LIST_TYPE
} from '../../../app/src/modules/unit-comments.js';
import {
  elementAt, elementPath, elementByPath, resolveAnchor, FingerprintCache
} from '../../../app/src/modules/node-anchor.js';

const DOC = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
  <text>
    <body/>
    <back>
      <listBibl>
        <bibl>Alpha 2001</bibl>
        <bibl>Beta 2002</bibl>
        <bibl>Gamma 2003</bibl>
      </listBibl>
    </back>
  </text>
  <standOff>
    <listAnnotation type="unit-comment"/>
  </standOff>
</TEI>`;

/**
 * @param {string} doc
 * @returns {EditorState}
 */
function makeState(doc) {
  return EditorState.create({ doc, extensions: [xml()] });
}

/**
 * Parses a serialized list into a DOM element.
 * @param {string} text
 * @returns {Element}
 */
function parseList(text) {
  const dom = new JSDOM(`<standOff xmlns="http://www.tei-c.org/ns/1.0">${text}</standOff>`, { contentType: 'application/xml' });
  return /** @type {Element} */ (dom.window.document.documentElement.firstElementChild);
}

describe('unit comments data', () => {
  it('serializes and reads threads with replies and status changes', () => {
    /** @type {import('../../../app/src/modules/unit-comments.js').UnitComment[]} */
    const comments = [];
    const first = addThread(comments, { author: 'jdoe', text: 'Is "ibid." <right>?', path: '/TEI/text/back/listBibl/bibl[2]', fingerprint: 'abcd1234', when: '2026-10-24T09:00:00Z' });
    addThread(comments, { author: 'jdoe', text: 'second', path: '/TEI/text/body', fingerprint: null, when: '2026-10-24T09:01:00Z' });
    addReply(comments, first.id, { author: 'asmith', text: 'Yes', when: '2026-10-24T09:02:00Z' });
    setThreadStatus(comments, first.id, 'resolved', { who: 'asmith', when: '2026-10-24T09:03:00Z' });

    const text = serializeComments(comments, '  ', '  ');
    assert.match(text, new RegExp(`^  <listAnnotation type="${LIST_TYPE}" subtype="fp-sha256-8-v1">`));
    assert.ok(text.includes('motivation="commenting" target="#xpath(/TEI/text/back/listBibl/bibl[2])" resp="#jdoe"'));
    assert.ok(text.includes(`motivation="replying" target="#${first.id}" resp="#asmith"`));
    assert.ok(text.includes('<change when="2026-10-24T09:03:00Z" who="#asmith" status="resolved"/>'));
    assert.ok(text.includes('<note type="comment">Is &quot;ibid.&quot; &lt;right&gt;?</note>'));

    const read = readComments(parseList(text));
    assert.deepStrictEqual(read, comments);
    // the reply follows its thread's first comment
    assert.deepStrictEqual(read.map(c => c.replyTo), [null, first.id, null]);

    const threads = buildThreads(read);
    assert.strictEqual(threads.length, 2);
    assert.strictEqual(threads[0]?.status, 'resolved');
    assert.strictEqual(threads[0]?.replies.length, 1);
    assert.strictEqual(threads[1]?.status, 'open');
  });

  it('reopens a resolved thread on reply', () => {
    /** @type {import('../../../app/src/modules/unit-comments.js').UnitComment[]} */
    const comments = [];
    const root = addThread(comments, { author: 'a', text: 'x', path: '/TEI/text', fingerprint: null });
    assert.strictEqual(setThreadStatus(comments, root.id, 'resolved', { who: 'a' }), true);
    assert.strictEqual(setThreadStatus(comments, root.id, 'resolved', { who: 'a' }), false);
    addReply(comments, root.id, { author: 'b', text: 'not done' });
    assert.strictEqual(threadStatus(root), 'open');
  });

  it('edits and deletes comments', () => {
    /** @type {import('../../../app/src/modules/unit-comments.js').UnitComment[]} */
    let comments = [];
    const root = addThread(comments, { author: 'a', text: 'x', path: '/TEI/text', fingerprint: null });
    const reply = /** @type {any} */ (addReply(comments, root.id, { author: 'b', text: 'y' }));
    assert.strictEqual(editComment(comments, reply.id, 'z', { who: 'b' }), true);
    assert.strictEqual(reply.text, 'z');
    assert.strictEqual(reply.changes.at(-1).status, 'edited');
    assert.strictEqual(deleteComment(comments, reply.id).length, 1);
    comments = deleteComment(comments, root.id);
    assert.strictEqual(comments.length, 0);
  });

  it('creates unused ids', () => {
    let n = 0;
    const values = [0, 0, 0.5];
    const id = newCommentId(['uc-000000'], () => /** @type {number} */ (values[n++]));
    assert.notStrictEqual(id, 'uc-000000');
    assert.match(id, /^uc-[0-9a-z]{6}$/);
  });
});

describe('element anchors', () => {
  it('computes and follows XPaths', () => {
    const state = makeState(DOC);
    const read = (/** @type {number} */ a, /** @type {number} */ b) => state.doc.sliceString(a, b);
    const beta = /** @type {any} */ (elementAt(state, DOC.indexOf('Beta')));
    assert.strictEqual(elementPath(beta, read), '/TEI/text/back/listBibl/bibl[2]');
    const body = /** @type {any} */ (elementAt(state, DOC.indexOf('<body')));
    assert.strictEqual(elementPath(body, read), '/TEI/text/body');
    assert.strictEqual(elementByPath(state, '/TEI/text/back/listBibl/bibl[2]')?.from, beta.from);
    assert.strictEqual(elementByPath(state, '/TEI/text/back/listBibl/bibl[4]'), null);
    // nothing to comment on in the stand-off data
    assert.strictEqual(elementAt(state, DOC.indexOf('listAnnotation')), null);
  });

  it('resolves anchors after edits', () => {
    const cache = new FingerprintCache();
    const state = makeState(DOC);
    const beta = /** @type {any} */ (resolveAnchor(state, { path: '/TEI/text/back/listBibl/bibl[2]', fingerprint: null }, cache));
    assert.strictEqual(beta.match, 'edited');
    const anchor = { path: beta.path, fingerprint: beta.fingerprint };
    assert.strictEqual(resolveAnchor(state, anchor, cache)?.match, 'exact');

    // a unit inserted before: found by its fingerprint
    const inserted = makeState(DOC.replace('<bibl>Alpha', '<bibl>New 2000</bibl>\n        <bibl>Alpha'));
    const moved = resolveAnchor(inserted, anchor, cache);
    assert.strictEqual(moved?.match, 'moved');
    assert.strictEqual(moved?.path, '/TEI/text/back/listBibl/bibl[3]');
    assert.ok(inserted.doc.sliceString(moved.from, moved.to).includes('Beta'));

    // the unit itself edited: found at its path
    const edited = resolveAnchor(makeState(DOC.replace('Beta 2002', 'Beta 2012')), anchor, cache);
    assert.strictEqual(edited?.match, 'edited');

    // both: the position tracked in the session decides
    const both = makeState(DOC.replace('<bibl>Alpha', '<bibl>New 2000</bibl>\n        <bibl>Alpha').replace('Beta 2002', 'Beta 2012'));
    const pos = both.doc.toString().indexOf('<bibl>Beta');
    assert.strictEqual(resolveAnchor(both, anchor, cache, pos)?.match, 'session');

    // the unit removed and the path gone: detached
    const removed = makeState(DOC.replace(/\s*<bibl>Gamma 2003<\/bibl>/, '').replace(/\s*<bibl>Beta 2002<\/bibl>/, ''));
    assert.strictEqual(resolveAnchor(removed, anchor, cache), null);
  });
});

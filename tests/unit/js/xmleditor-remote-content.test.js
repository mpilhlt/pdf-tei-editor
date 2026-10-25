#!/usr/bin/env node

/**
 * Verifies XMLEditor.applyRemoteContent(): another user's version of the document is applied as
 * changes to the changed ranges only, without making the editor dirty or adding undo history, and
 * is refused when it cannot be applied safely.
 *
 * @testCovers app/src/modules/xmleditor.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.Window = dom.window.Window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.XPathResult = dom.window.XPathResult;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
if (!global.window.getSelection) {
  global.window.getSelection = () => ({
    rangeCount: 0, addRange() {}, removeAllRanges() {},
    getRangeAt() { return { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 }; }
  });
}
if (!global.document.getSelection) global.document.getSelection = global.window.getSelection;
if (!global.Range) global.Range = dom.window.Range;
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;


const { undoDepth } = await import('@codemirror/commands');
const { XMLEditor, isRemoteUpdate } = await import('../../../app/src/modules/xmleditor.js');

const body = (/** @type {string} */ p) => `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/><text><body><p>One</p><p>${p}</p><p>Three</p></body></text></TEI>`;

/**
 * @param {string} xml
 * @returns {Promise<XMLEditor>}
 */
async function createLoadedEditor(xml) {
  const parent = document.getElementById('editor');
  parent.innerHTML = '';
  const editor = new XMLEditor('editor');
  await editor.loadXml(xml);
  return editor;
}

describe('XMLEditor.applyRemoteContent', () => {
  it('replaces only the changed range, keeps the editor clean and adds no history', async () => {
    const editor = await createLoadedEditor(body('Two'));
    /** @type {any[]} */
    const updates = [];
    editor.addUpdateListener(update => { if (update.docChanged) updates.push(update); });
    const view = editor.getView();
    const pos = view.state.doc.toString().indexOf('Three');
    view.dispatch({ selection: { anchor: pos } });
    assert.strictEqual(await editor.applyRemoteContent(body('Two changed')), true);
    assert.strictEqual(view.state.doc.toString(), body('Two changed'));
    assert.strictEqual(editor.isDirty(), false);
    assert.strictEqual(undoDepth(view.state), 0);
    // the cursor moves with its text
    assert.strictEqual(view.state.selection.main.head, view.state.doc.toString().indexOf('Three'));
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(isRemoteUpdate(updates[0]), true);
    let inserted = 0;
    updates[0].changes.iterChanges((/** @type {number} */ fromA, /** @type {number} */ toA, /** @type {number} */ _fromB, /** @type {number} */ _toB, /** @type {any} */ text) => { inserted += text.length; });
    assert.strictEqual(inserted, ' changed'.length);
    assert.ok(editor.getXmlTree()?.documentElement.textContent?.includes('Two changed'));
  });

  it('refuses malformed text, a dirty editor and a mostly different document', async () => {
    const editor = await createLoadedEditor(body('Two'));
    assert.strictEqual(await editor.applyRemoteContent('<TEI><text>'), false);
    assert.strictEqual(await editor.applyRemoteContent('<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body><div>completely different content here, much longer than before</div></body></text></TEI>'), false);
    const view = editor.getView();
    view.dispatch({ changes: { from: view.state.doc.toString().indexOf('One'), insert: 'X' } });
    assert.strictEqual(editor.isDirty(), true);
    assert.strictEqual(await editor.applyRemoteContent(body('Two changed')), false);
  });
});

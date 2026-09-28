#!/usr/bin/env node

/**
 * Verifies XMLEditor.setEditGuardXpath(): a soft, UI-only guard that rejects
 * user-driven edits (transactions carrying a userEvent annotation) touching the
 * content of the element matched by the given XPath, while leaving edits
 * elsewhere in the document and programmatic transactions unaffected.
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

const { Transaction } = await import('@codemirror/state');
const { XMLEditor } = await import('../../../app/src/modules/xmleditor.js');

// jsdom's XPath engine does not resolve prefixes against a default-namespaced
// document (unlike real browsers), so the fixture uses an explicit `tei:` prefix,
// matching the convention already used in tests/unit/fastapi/test_xml_utils.py.
const TEI_XML = '<tei:TEI xmlns:tei="http://www.tei-c.org/ns/1.0"><tei:teiHeader><tei:fileDesc><tei:titleStmt><tei:title>Title</tei:title></tei:titleStmt></tei:fileDesc></tei:teiHeader><tei:text><tei:body><tei:p>Hello</tei:p></tei:body></tei:text></tei:TEI>';

// Same document, preceded by an xml-model PI, for whitelist-mode tests covering
// the root tag and the PI (both outside <text>, neither caught by a
// teiHeader-only blacklist).
const TEI_XML_WITH_PI = '<?xml-model href="http://example.org/tei.rng" type="application/xml"?>\n' + TEI_XML;

/**
 * Creates a fresh XMLEditor with the given XML string loaded (defaults to the
 * plain TEI fixture without a PI).
 * @param {string} [xml]
 * @returns {Promise<XMLEditor>}
 */
async function createLoadedEditor(xml = TEI_XML) {
  const parent = document.getElementById('editor');
  parent.innerHTML = '';
  const editor = new XMLEditor('editor');
  await editor.loadXml(xml);
  return editor;
}

/**
 * Dispatches a single-character user-event insertion at `pos` and returns
 * whether the document actually changed.
 * @param {XMLEditor} editor
 * @param {number} pos
 * @returns {boolean}
 */
function tryUserInsert(editor, pos) {
  const before = editor.getView().state.doc.toString();
  editor.getView().dispatch({
    changes: { from: pos, to: pos, insert: 'X' },
    annotations: Transaction.userEvent.of('input.type')
  });
  return editor.getView().state.doc.toString() !== before;
}

describe('XMLEditor.setEditGuardXpath', () => {
  it('rejects a user-event edit inside the guarded element', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:teiHeader');

    const headerNode = editor.getSyntaxNodeByXpath('//tei:teiHeader');
    const pos = Math.floor((headerNode.from + headerNode.to) / 2);
    const before = editor.getView().state.doc.toString();

    editor.getView().dispatch({
      changes: { from: pos, to: pos, insert: 'X' },
      annotations: Transaction.userEvent.of('input.type')
    });

    assert.strictEqual(
      editor.getView().state.doc.toString(),
      before,
      'A user-event edit inside the guarded teiHeader must be rejected'
    );
  });

  it('allows a user-event edit outside the guarded element', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:teiHeader');

    const textNode = editor.getSyntaxNodeByXpath('//tei:text');
    const pos = Math.floor((textNode.from + textNode.to) / 2);
    const before = editor.getView().state.doc.toString();

    editor.getView().dispatch({
      changes: { from: pos, to: pos, insert: 'X' },
      annotations: Transaction.userEvent.of('input.type')
    });

    assert.strictEqual(
      editor.getView().state.doc.toString(),
      before.slice(0, pos) + 'X' + before.slice(pos),
      'A user-event edit inside <text> must be applied unchanged'
    );
  });

  it('allows a programmatic edit inside the guarded element', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:teiHeader');

    const headerNode = editor.getSyntaxNodeByXpath('//tei:teiHeader');
    const pos = Math.floor((headerNode.from + headerNode.to) / 2);
    const before = editor.getView().state.doc.toString();

    // No userEvent annotation: simulates a programmatic write (e.g. document load, sync).
    editor.getView().dispatch({
      changes: { from: pos, to: pos, insert: 'X' }
    });

    assert.strictEqual(
      editor.getView().state.doc.toString(),
      before.slice(0, pos) + 'X' + before.slice(pos),
      'A programmatic edit inside teiHeader must not be blocked'
    );
  });

  it('setEditGuardXpath(null) removes the guard', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:teiHeader');
    editor.setEditGuardXpath(null);

    const headerNode = editor.getSyntaxNodeByXpath('//tei:teiHeader');
    const pos = Math.floor((headerNode.from + headerNode.to) / 2);
    const before = editor.getView().state.doc.toString();

    editor.getView().dispatch({
      changes: { from: pos, to: pos, insert: 'X' },
      annotations: Transaction.userEvent.of('input.type')
    });

    assert.strictEqual(
      editor.getView().state.doc.toString(),
      before.slice(0, pos) + 'X' + before.slice(pos),
      'After clearing the guard, user-event edits inside teiHeader must be applied'
    );
  });
});

describe('XMLEditor.setEditGuardXpath (whitelist mode)', () => {
  it('allows a user-event edit inside the whitelisted element', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:text', { mode: 'whitelist' });

    const textNode = editor.getSyntaxNodeByXpath('//tei:text');
    const pos = Math.floor((textNode.from + textNode.to) / 2);

    assert.strictEqual(tryUserInsert(editor, pos), true, 'A user-event edit inside <text> must be applied');
  });

  it('rejects a user-event edit inside teiHeader (outside the whitelist)', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:text', { mode: 'whitelist' });

    const headerNode = editor.getSyntaxNodeByXpath('//tei:teiHeader');
    const pos = Math.floor((headerNode.from + headerNode.to) / 2);

    assert.strictEqual(tryUserInsert(editor, pos), false, 'A user-event edit inside teiHeader must be rejected in whitelist(text) mode');
  });

  it('rejects a user-event edit on the TEI root tag (outside the whitelist)', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:text', { mode: 'whitelist' });

    const doc = editor.getView().state.doc.toString();
    const pos = doc.indexOf('xmlns:tei') + 1; // inside the root tag's attribute list

    assert.strictEqual(tryUserInsert(editor, pos), false, 'A user-event edit on the TEI root tag must be rejected in whitelist(text) mode');
  });

  it('rejects a user-event edit inside an xml-model PI preceding the root (outside the whitelist)', async () => {
    const editor = await createLoadedEditor(TEI_XML_WITH_PI);
    editor.setEditGuardXpath('//tei:text', { mode: 'whitelist' });

    const doc = editor.getView().state.doc.toString();
    const pos = doc.indexOf('xml-model') + 1;

    assert.strictEqual(tryUserInsert(editor, pos), false, 'A user-event edit inside a PI must be rejected in whitelist(text) mode');
  });

  it('allows a programmatic edit outside the whitelisted element', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:text', { mode: 'whitelist' });

    const headerNode = editor.getSyntaxNodeByXpath('//tei:teiHeader');
    const pos = Math.floor((headerNode.from + headerNode.to) / 2);
    const before = editor.getView().state.doc.toString();

    // No userEvent annotation: simulates a programmatic write.
    editor.getView().dispatch({ changes: { from: pos, to: pos, insert: 'X' } });

    assert.strictEqual(
      editor.getView().state.doc.toString(),
      before.slice(0, pos) + 'X' + before.slice(pos),
      'A programmatic edit outside <text> must not be blocked in whitelist mode'
    );
  });

  it('setEditGuardXpath(null) removes a whitelist guard', async () => {
    const editor = await createLoadedEditor();
    editor.setEditGuardXpath('//tei:text', { mode: 'whitelist' });
    editor.setEditGuardXpath(null);

    const headerNode = editor.getSyntaxNodeByXpath('//tei:teiHeader');
    const pos = Math.floor((headerNode.from + headerNode.to) / 2);

    assert.strictEqual(tryUserInsert(editor, pos), true, 'After clearing the guard, user-event edits outside <text> must be applied');
  });
});

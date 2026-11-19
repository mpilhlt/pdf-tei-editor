#!/usr/bin/env node

/**
 * Verifies the navigation by milestones such as <pb/>: a milestone's range runs to the next one,
 * focus mode focuses that range, and the cursor selects the milestone whose range holds it.
 *
 * @testCovers app/src/modules/xmleditor.js
 * @testCovers app/src/modules/navigatable-xmleditor.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Set up jsdom globals BEFORE importing CodeMirror.
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="editor"></div></body></html>');
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.Window = dom.window.Window;
global.document = dom.window.document;
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
// jsdom has no layout; CodeMirror measures ranges when scrolling and drawing the selection
dom.window.Range.prototype.getClientRects = () => /** @type {any} */ ([]);
dom.window.Range.prototype.getBoundingClientRect = () => /** @type {any} */ ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;
if (!global.XMLSerializer) global.XMLSerializer = dom.window.XMLSerializer;
if (!global.DOMParser) global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.XPathResult = dom.window.XPathResult;

const { focusRangeField } = await import('../../../app/src/modules/codemirror/focus-mode.js');
const { NavXmlEditor } = await import('../../../app/src/modules/navigatable-xmleditor.js');


const DOC = `<TEI>
  <teiHeader/>
  <text xml:lang="en">
    <pb n="1"/>
    <titlePage>Journal of Samples <lb/>Cover page <lb/></titlePage>
    <body>The body <lb/>continues <lb/><pb n="2"/>on the next page <lb/></body>
    <pb n="3"/>
    <page>3 <lb/></page>
    <body>Last page <lb/></body>
  </text>
</TEI>`;

/** @returns {Promise<NavXmlEditor>} */
async function editorWith(xml) {
  const div = document.createElement('div');
  div.id = `editor-${Date.now()}-${Math.random()}`;
  document.body.appendChild(div);
  const editor = new NavXmlEditor(div.id, null);
  await editor.loadXml(xml);
  editor.parentPath = '//pb';
  return editor;
}

/** @param {NavXmlEditor} editor @param {{from: number, to: number}} range */
function textOf(editor, range) {
  return editor.getView().state.doc.sliceString(range.from, range.to);
}

describe('milestone navigation', () => {
  // jsdom's XPath engine gets `(//pb)[n]` wrong for nested milestones (it returns pb 3 for n=2), so
  // the tests take the milestones from the `//pb` snapshot, which is in document order
  it('ranges run from a milestone to the next one or the end of <text>', async () => {
    const editor = await editorWith(DOC);
    const [pb1, pb2, pb3] = editor.getDomNodesByXpath('//pb');
    assert.strictEqual(textOf(editor, editor.getNodeRange(pb1)),
      '<pb n="1"/>\n    <titlePage>Journal of Samples <lb/>Cover page <lb/></titlePage>\n    <body>The body <lb/>continues <lb/>');
    assert.strictEqual(textOf(editor, editor.getNodeRange(pb2)), '<pb n="2"/>on the next page <lb/></body>');
    assert.strictEqual(textOf(editor, editor.getNodeRange(pb3)), '<pb n="3"/>\n    <page>3 <lb/></page>\n    <body>Last page <lb/></body>');
    assert.deepStrictEqual(editor.getRangeByXpath('//pb[1]'), editor.getNodeRange(pb1));
    // other elements keep their own range
    assert.strictEqual(textOf(editor, editor.getRangeByXpath('//page[1]')), '<page>3 <lb/></page>');
  });

  it('focus mode focuses the range of the milestone', async () => {
    const editor = await editorWith(DOC);
    editor.setFocusMode(true);
    const pb2 = editor.getDomNodesByXpath('//pb')[1];
    editor.focusDomNode(pb2);
    const range = editor.getView().state.field(focusRangeField);
    assert.deepStrictEqual(range, editor.getNodeRange(pb2));
    // the cursor is placed after the milestone
    assert.strictEqual(editor.getView().state.selection.main.head, range.from + '<pb n="2"/>'.length);
  });

  it('the cursor selects the milestone whose range holds it', async () => {
    const editor = await editorWith(DOC);
    const text = editor.getView().state.doc.toString();
    for (const [needle, index] of [['Cover page', 1], ['continues', 1], ['on the next page', 2], ['Last page', 3]]) {
      editor.selectedNode = null;
      const pos = text.indexOf(needle);
      await editor.handeSelectionChange([{ from: pos, to: pos, node: editor.getDomNodeAt(pos) }]);
      assert.strictEqual(editor.selectedXpath, `//pb[${index}]`, needle);
    }
  });
});

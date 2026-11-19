#!/usr/bin/env node

/**
 * Verifies that accepting all changes of a merge view applies every change in one undo step,
 * also insertions of whole lines (such as the <pb/> elements of the TEI Wizard's "Insert page breaks").
 *
 * @testCovers app/src/modules/xmleditor.js
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

const { undo, undoDepth } = await import('@codemirror/commands');
const { NavXmlEditor } = await import('../../../app/src/modules/navigatable-xmleditor.js');

const DOC = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text xml:lang="en">
    <titlePage>Journal of Samples <lb/>Cover page <lb/></titlePage>
    <front>A Sample Article <lb/>Jane Doe <lb/></front>
    <body>1 Introduction <lb/>The body <lb/></body>
    <page>2</page> <note place="headnote">Doe, A Sample Article <lb/></note>
    <body>The second page <lb/>more text <lb/></body>
    <note place="headnote">Doe, A Sample Article <lb/></note>
    <body>Third page. <lb/></body>
  </text>
</TEI>`;
const WITH_PB = DOC
  .replace('    <titlePage>', '    <pb n="1"/>\n    <titlePage>')
  .replace('    <page>2</page>', '    <pb n="2"/>\n    <page>2</page>')
  .replace('    <note place="headnote">Doe, A Sample Article <lb/></note>\n    <body>Third', '    <pb n="3"/>\n    <note place="headnote">Doe, A Sample Article <lb/></note>\n    <body>Third')
  .replace('The body <lb/>', 'The <pb n="9"/>body <lb/>');

/** @returns {Promise<NavXmlEditor>} */
async function editorWith(xml) {
  const div = document.createElement('div');
  div.id = `editor-${Date.now()}-${Math.random()}`;
  document.body.appendChild(div);
  const editor = new NavXmlEditor(div.id, null);
  await editor.loadXml(xml);
  return editor;
}

describe('accepting all changes of a merge view', () => {
  for (const ignoreWhitespace of [true, false]) {
    it(`applies inserted lines and inline insertions (ignore whitespace: ${ignoreWhitespace})`, async () => {
      const editor = await editorWith(DOC);
      editor.setIgnoreWhitespaceInDiff(ignoreWhitespace);
      await editor.showMergeView(WITH_PB);
      const synced = new Promise(resolve => editor.once('editorXmlWellFormed', resolve));
      editor.acceptAllDiffs();
      await synced;
      assert.strictEqual(editor.getEditorContent(), WITH_PB);
    });
  }

  it('applies all changes in one undo step', async () => {
    const editor = await editorWith(DOC);
    await editor.showMergeView(WITH_PB);
    editor.acceptAllDiffs();
    const view = editor.getView();
    assert.strictEqual(view.state.doc.toString(), WITH_PB);
    assert.strictEqual(undoDepth(view.state), 1);
    undo(view);
    assert.strictEqual(view.state.doc.toString(), DOC);
  });
});

#!/usr/bin/env node

/**
 * Verifies that focus mode keeps the focus on the navigated-to node when a merge view is
 * accepted (which replaces whole lines, including the node's boundaries) or rejected.
 *
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

const { NavXmlEditor } = await import('../../../app/src/modules/navigatable-xmleditor.js');
const { focusRangeField } = await import('../../../app/src/modules/codemirror/focus-mode.js');

const BIBLS = [1, 2, 3, 4].map(i => `  <bibl><author>A${i}</author> <title>T${i}</title></bibl>`).join('\n');
const DOC = `<TEI><text><body><listBibl>\n${BIBLS}\n</listBibl></body></text></TEI>`;
const MODIFIED = DOC.replace('<title>T2</title>', '<title level="m">T2</title>');

/** @returns {Promise<NavXmlEditor>} editor with focus mode on and the second bibl focused */
async function focusedEditor() {
  const div = document.createElement('div');
  div.id = `editor-${Date.now()}-${Math.random()}`;
  document.body.appendChild(div);
  const editor = new NavXmlEditor(div.id, null);
  await editor.loadXml(DOC);
  editor.parentPath = '//bibl';
  editor.setFocusMode(true);
  editor.selectByIndex(2);
  return editor;
}

/** @param {NavXmlEditor} editor */
function assertFocusOnSecondBibl(editor) {
  const { from, to } = editor.getSyntaxNodeByXpath('//bibl[2]');
  assert.deepStrictEqual(editor.getView().state.field(focusRangeField), { from, to });
}

describe('focus mode and merge view', () => {
  it('keeps the focus on the node after accepting the changes', async () => {
    const editor = await focusedEditor();
    assertFocusOnSecondBibl(editor);
    await editor.showMergeView(MODIFIED);
    // in the browser, accepting reports no selection change into the node (which would move the
    // focus along); disable that path so that only the realignment after the sync can restore the focus
    editor.handeSelectionChange = async () => {};
    const synced = new Promise(resolve => editor.once('editorXmlWellFormed', resolve));
    editor.acceptAllDiffs();
    await synced;
    assert.ok(editor.getEditorContent().includes('<title level="m">T2</title>'));
    assertFocusOnSecondBibl(editor);
  });

  it('keeps the focus on the node after rejecting the changes', async () => {
    const editor = await focusedEditor();
    await editor.showMergeView(MODIFIED);
    editor.rejectAllDiffs();
    assertFocusOnSecondBibl(editor);
  });
});

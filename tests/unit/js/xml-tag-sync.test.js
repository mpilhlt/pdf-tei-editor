#!/usr/bin/env node

/**
 * Test suite for the xmlTagSync CodeMirror ViewPlugin.
 *
 * Creates a real CodeMirror EditorView in jsdom and verifies that editing
 * an opening or closing tag name mirrors the change to its counterpart.
 *
 * @testCovers app/src/modules/codemirror/xml-tag-sync.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Set up jsdom globals BEFORE importing CodeMirror (it probes for `document`).
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
// CM uses this.win.requestAnimationFrame (the parent element's ownerDocument window),
// so we must patch the jsdom window, not just the Node global.
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.document = dom.window.document;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
// jsdom doesn't implement getSelection — stub it for CM
if (!global.window.getSelection) {
  global.window.getSelection = () => ({
    rangeCount: 0,
    addRange() {},
    removeAllRanges() {},
    getRangeAt() { return { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 }; }
  });
}
// DocumentOrShadowRoot.getSelection polyfill
if (!global.document.getSelection) {
  global.document.getSelection = global.window.getSelection;
}

// Provide Range/StaticRange if missing
if (!global.Range) global.Range = dom.window.Range;
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;

const { EditorState } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const { xml } = await import('@codemirror/lang-xml');
const { syntaxTree, ensureSyntaxTree } = await import('@codemirror/language');
const { xmlTagSync } = await import('../../../app/src/modules/codemirror/xml-tag-sync.js');

/**
 * Helper: create an EditorView with xmlTagSync enabled.
 * @param {string} doc Initial document content
 * @returns {EditorView}
 */
function createView(doc) {
  const parent = document.getElementById('editor');
  // Clear previous content
  parent.innerHTML = '';
  const state = EditorState.create({
    doc,
    extensions: [xml(), xmlTagSync]
  });
  return new EditorView({ state, parent });
}

/**
 * Helper: force a full parse of the document so the syntax tree is available
 * for the plugin's logic. In a real browser Lezer parses incrementally; in
 * tests we need to ensure it finishes before we inspect the tree.
 * @param {EditorView} view
 */
function ensureParsed(view) {
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
}

/**
 * Helper: simulate a user edit by dispatching a change and then ensuring the
 * tree is re-parsed. Returns the resulting document string.
 * @param {EditorView} view
 * @param {{ from: number, to: number, insert: string }} change
 * @returns {string}
 */
function applyChange(view, change) {
  view.dispatch({ changes: change });
  ensureParsed(view);
  return view.state.doc.toString();
}

// ---------------------------------------------------------------------------

describe('xmlTagSync plugin', () => {

  describe('open → close sync', () => {

    it('should sync a single character insertion in the opening tag', () => {
      //                 0123456789...
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Insert 'x' at the end of the opening tag name: "tag" → "tagx"
      // "tag" occupies positions 1–4 in "<tag>"
      const result = applyChange(view, { from: 4, to: 4, insert: 'x' });
      assert.strictEqual(result, '<tagx>text</tagx>');
    });

    it('should sync a single character deletion in the opening tag', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Delete last char of opening tag name: "tag" → "ta"
      const result = applyChange(view, { from: 3, to: 4, insert: '' });
      assert.strictEqual(result, '<ta>text</ta>');
    });

    it('should sync a full rename of the opening tag', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Replace "tag" (positions 1–4) with "div"
      const result = applyChange(view, { from: 1, to: 4, insert: 'div' });
      assert.strictEqual(result, '<div>text</div>');
    });

    it('should sync multiple sequential edits', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // First edit: "tag" → "tags"
      applyChange(view, { from: 4, to: 4, insert: 's' });
      assert.strictEqual(view.state.doc.toString(), '<tags>text</tags>');

      // Second edit: "tags" → "tagsx"
      // After first edit, opening tag name is at positions 1-5 ("tags")
      applyChange(view, { from: 5, to: 5, insert: 'x' });
      assert.strictEqual(view.state.doc.toString(), '<tagsx>text</tagsx>');
    });

    it('should handle inserting then deleting (the original bug scenario)', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Insert 'x': "tag" → "tagx"
      applyChange(view, { from: 4, to: 4, insert: 'x' });
      assert.strictEqual(view.state.doc.toString(), '<tagx>text</tagx>');

      // Delete the 'x': "tagx" → "tag"
      applyChange(view, { from: 4, to: 5, insert: '' });
      assert.strictEqual(view.state.doc.toString(), '<tag>text</tag>');
    });
  });

  describe('close → open sync', () => {

    it('should sync a character insertion in the closing tag', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Closing tag name is "</tag>", "tag" starts at position 11
      // (0:<)(1:t)(2:a)(3:g)(4:>)(5:t)(6:e)(7:x)(8:t)(9:<)(10:/)(11:t)(12:a)(13:g)(14:>)
      const result = applyChange(view, { from: 14, to: 14, insert: 'x' });
      assert.strictEqual(result, '<tagx>text</tagx>');
    });

    it('should sync a full rename of the closing tag', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Replace "tag" in "</tag>" (positions 11–14) with "div"
      const result = applyChange(view, { from: 11, to: 14, insert: 'div' });
      assert.strictEqual(result, '<div>text</div>');
    });
  });

  describe('nested elements', () => {

    it('should sync only the outer tag, not nested tags', () => {
      const initial = '<outer><inner>text</inner></outer>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename "outer" (positions 1–6) to "div"
      const result = applyChange(view, { from: 1, to: 6, insert: 'div' });
      assert.strictEqual(result, '<div><inner>text</inner></div>');
    });

    it('should sync an inner tag without affecting the outer tag', () => {
      const initial = '<outer><inner>text</inner></outer>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename "inner" in the opening tag (positions 8–13) to "span"
      const result = applyChange(view, { from: 8, to: 13, insert: 'span' });
      assert.strictEqual(result, '<outer><span>text</span></outer>');
    });

    it('should sync the outer closing tag without matching inner opening tags', () => {
      const initial = '<outer><inner>text</inner></outer>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename "outer" in "</outer>" (positions 27–32) to "div"
      const result = applyChange(view, { from: 27, to: 32, insert: 'div' });
      assert.strictEqual(result, '<div><inner>text</inner></div>');
    });

    it('should handle deeply nested elements', () => {
      const initial = '<a><b><c>x</c></b></a>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename middle element "b" (position 4–5) to "bb"
      const result = applyChange(view, { from: 4, to: 5, insert: 'bb' });
      assert.strictEqual(result, '<a><bb><c>x</c></bb></a>');
    });

    it('should handle multiple sibling elements', () => {
      const initial = '<root><a>1</a><b>2</b></root>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename "a" (position 7–8) to "x"
      const result = applyChange(view, { from: 7, to: 8, insert: 'x' });
      assert.strictEqual(result, '<root><x>1</x><b>2</b></root>');
    });
  });

  describe('edge cases', () => {

    it('should not act on self-closing tags (no counterpart)', () => {
      const initial = '<root><br/>text</root>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename "br" in "<br/>" — no close tag to sync
      const result = applyChange(view, { from: 7, to: 9, insert: 'hr' });
      // Should just rename the self-closing tag, nothing else changes
      assert.strictEqual(result, '<root><hr/>text</root>');
    });

    it('should not act when change is outside a tag name', () => {
      const initial = '<tag>text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Edit the text content (position 5–9)
      const result = applyChange(view, { from: 5, to: 9, insert: 'hello' });
      assert.strictEqual(result, '<tag>hello</tag>');
    });

    it('should handle attributes in the opening tag', () => {
      const initial = '<tag attr="v">text</tag>';
      const view = createView(initial);
      ensureParsed(view);

      // Rename "tag" (positions 1–4) to "div"
      const result = applyChange(view, { from: 1, to: 4, insert: 'div' });
      assert.strictEqual(result, '<div attr="v">text</div>');
    });
  });
});

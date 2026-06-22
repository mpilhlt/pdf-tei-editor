#!/usr/bin/env node

/**
 * Verifies that NavXmlEditor applies each theme's readOnlyBackground to the
 * CodeMirror view when setReadOnlyBackground(true) is called (access-control path),
 * and that setReadOnly() alone does NOT change the background (annotation-mode path).
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
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;
if (!global.XMLSerializer) global.XMLSerializer = dom.window.XMLSerializer;
if (!global.DOMParser) global.DOMParser = dom.window.DOMParser;

const { NavXmlEditor } = await import('../../../app/src/modules/navigatable-xmleditor.js');
const { EditorView } = await import('@codemirror/view');

/**
 * Create a fresh editor div and NavXmlEditor for each test to avoid state bleed.
 * @returns {NavXmlEditor}
 */
function createEditor() {
  const div = document.createElement('div');
  div.id = `editor-${Date.now()}`;
  document.body.appendChild(div);
  return new NavXmlEditor(div.id, null, console);
}

describe('NavXmlEditor read-only background (access-control path)', () => {
  it('setReadOnlyBackground(false) clears the inline style', async () => {
    const editor = createEditor();
    editor.setReadOnlyBackground(true);
    editor.setReadOnlyBackground(false);
    assert.strictEqual(
      editor.getView().dom.style.backgroundColor,
      '',
      'Expected background-color inline style to be cleared after setReadOnlyBackground(false)'
    );
  });

});

describe('NavXmlEditor read-only background (annotation-mode path)', () => {
  it('setReadOnly(true) alone does NOT apply a background (annotation mode)', async () => {
    const editor = createEditor();
    await editor.setReadOnly(true);
    assert.strictEqual(
      editor.getView().dom.style.backgroundColor,
      '',
      'setReadOnly(true) must not change background — annotation mode should look normal'
    );
    assert.strictEqual(
      editor.getView().state.facet(EditorView.editable),
      false,
      'Editor should be non-editable after setReadOnly(true)'
    );
    await editor.setReadOnly(false);
  });
});

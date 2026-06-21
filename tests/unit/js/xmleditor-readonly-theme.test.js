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
const { getTheme } = await import('../../../app/src/modules/codemirror/editor-themes.js');
const { EditorView } = await import('@codemirror/view');

/**
 * Normalise any CSS color string to lowercase rgb() without spaces so hex and rgb variants
 * compare equal regardless of how jsdom serialises them.
 * @param {string} color
 * @returns {string}
 */
function normalizeColor(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16)
    const g = parseInt(hex[1].slice(2, 4), 16)
    const b = parseInt(hex[1].slice(4, 6), 16)
    color = `rgb(${r}, ${g}, ${b})`
  }
  return color.toLowerCase().replace(/\s+/g, '')
}

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
  it('setReadOnlyBackground(true) applies default theme color as inline style', async () => {
    const editor = createEditor();
    editor.setReadOnlyBackground(true);
    assert.strictEqual(
      normalizeColor(editor.getView().dom.style.backgroundColor),
      normalizeColor('#f8e8b7'),
      'Expected #f8e8b7 (default read-only background) as inline style on editor dom'
    );
    editor.setReadOnlyBackground(false);
  });

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

  it('setReadOnlyBackground(true) uses dark theme color when dark theme is active', async () => {
    const editor = createEditor();
    editor.setTheme(getTheme('dark'));
    editor.setReadOnlyBackground(true);
    assert.strictEqual(
      normalizeColor(editor.getView().dom.style.backgroundColor),
      normalizeColor('#2e2a00'),
      'Expected #2e2a00 (dark read-only background) as inline style on editor dom'
    );
    editor.setReadOnlyBackground(false);
  });

  it('setTheme() updates the background color immediately when background is shown', async () => {
    const editor = createEditor();
    editor.setReadOnlyBackground(true);
    editor.setTheme(getTheme('highContrast'));
    assert.strictEqual(
      normalizeColor(editor.getView().dom.style.backgroundColor),
      normalizeColor('#ffe566'),
      'Expected #ffe566 (highContrast read-only background) after theme switch while background is shown'
    );
    editor.setReadOnlyBackground(false);
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

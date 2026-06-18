#!/usr/bin/env node

/**
 * Tests for XMLEditor.createExtensionSlot() — injects a compartment into a live CM state.
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
global.document = dom.window.document;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
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

const { StateEffect, Facet } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const { xml } = await import('@codemirror/lang-xml');
const { XMLEditor } = await import('../../../app/src/modules/xmleditor.js');

function createEditor() {
  const parent = document.getElementById('editor');
  parent.innerHTML = '';
  return new XMLEditor('editor');
}

describe('XMLEditor.createExtensionSlot', () => {
  it('returns a reconfigure function', () => {
    const editor = createEditor();
    const slot = editor.createExtensionSlot([]);
    assert.strictEqual(typeof slot.reconfigure, 'function');
  });

  it('reconfigure installs and removes extensions without throwing', () => {
    const editor = createEditor();
    const slot = editor.createExtensionSlot([]);
    // A no-op extension to toggle
    const testFacet = Facet.define();
    const ext = testFacet.of(true);
    assert.doesNotThrow(() => slot.reconfigure(ext));
    assert.doesNotThrow(() => slot.reconfigure([]));
  });

  it('multiple slots are independent', () => {
    const editor = createEditor();
    const slot1 = editor.createExtensionSlot([]);
    const slot2 = editor.createExtensionSlot([]);
    const testFacet = Facet.define();
    assert.doesNotThrow(() => {
      slot1.reconfigure(testFacet.of(1));
      slot2.reconfigure(testFacet.of(2));
      slot1.reconfigure([]);
    });
  });
});

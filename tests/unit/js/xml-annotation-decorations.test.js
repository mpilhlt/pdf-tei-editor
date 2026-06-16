#!/usr/bin/env node

/**
 * Tests for xml-annotation-decorations.js — label resolution and StateField factory.
 *
 * @testCovers app/src/modules/codemirror/xml-annotation-decorations.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.document = dom.window.document;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
global.XMLSerializer = dom.window.XMLSerializer;
global.DOMParser = dom.window.DOMParser;
if (!global.window.getSelection) {
  global.window.getSelection = () => ({
    rangeCount: 0, addRange() {}, removeAllRanges() {},
    getRangeAt() { return { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 }; }
  });
}
if (!global.document.getSelection) global.document.getSelection = global.window.getSelection;
if (!global.Range) global.Range = dom.window.Range;
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;

const { resolveLabel, createAnnotationField } = await import('../../../app/src/modules/codemirror/xml-annotation-decorations.js');
const { EditorState } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const { xml } = await import('@codemirror/lang-xml');

/** @param {Element} el @param {Record<string,string>} attrs */
function mockElement(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe('resolveLabel', () => {
  const tagDef = {
    tag: 'title',
    label: 'TITLE[{@level}]',
    labelMap: { 'level=m': 'TITLE[M]', 'level=a': 'TITLE[A]' },
    color: '#a6e3a1',
    attributes: []
  };

  it('uses labelMap when attribute matches', () => {
    const el = mockElement(document.createElement('title'), { level: 'm' });
    assert.strictEqual(resolveLabel(tagDef, el), 'TITLE[M]');
  });

  it('falls back to template interpolation when no labelMap match', () => {
    const el = mockElement(document.createElement('title'), { level: 's' });
    assert.strictEqual(resolveLabel(tagDef, el), 'TITLE[s]');
  });

  it('removes brackets around absent attribute', () => {
    const el = document.createElement('title'); // no level attr
    assert.strictEqual(resolveLabel(tagDef, el), 'TITLE');
  });

  it('returns plain label when no template tokens', () => {
    const plain = { tag: 'bibl', label: 'BIBL', color: '#89dceb', attributes: [] };
    const el = document.createElement('bibl');
    assert.strictEqual(resolveLabel(plain, el), 'BIBL');
  });
});

describe('createAnnotationField', () => {
  const tagDefs = [
    { tag: 'bibl', label: 'BIBL', color: '#89dceb', attributes: [] }
  ];
  const field = createAnnotationField(tagDefs);

  function makeView(doc) {
    const parent = document.getElementById('editor');
    parent.innerHTML = '';
    return new EditorView({
      state: EditorState.create({ doc, extensions: [xml(), field] }),
      parent
    });
  }

  it('creates a StateField without throwing', () => {
    assert.doesNotThrow(() => makeView('<root><bibl>Smith 1987</bibl></root>'));
  });

  it('produces decorations for a known annotation tag', () => {
    const view = makeView('<root><bibl>Smith 1987</bibl></root>');
    const decos = view.state.field(field);
    assert.ok(decos.size > 0, 'should produce at least one decoration for <bibl>');
  });
});

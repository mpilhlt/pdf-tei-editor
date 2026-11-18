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
global.Window = dom.window.Window;
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
  it('returns tag[value] when a variant attribute is set', () => {
    const tagDef = {
      tag: 'title',
      label: 'title',
      color: '#a6e3a1',
      attributes: [],
      variants: [
        { attrs: { level: 'a' } },
        { attrs: { level: 'm' } },
      ],
    };
    const el = mockElement(document.createElement('title'), { level: 'm' });
    assert.strictEqual(resolveLabel(tagDef, el), 'title[m]');
  });

  it('joins multiple variant-controlled attribute values', () => {
    const tagDef = {
      tag: 'title',
      label: 'title',
      color: '#a6e3a1',
      attributes: [],
      variants: [
        { attrs: { level: 'm', type: 'legislation' } },
      ],
    };
    const el = mockElement(document.createElement('title'), { level: 'm', type: 'legislation' });
    assert.strictEqual(resolveLabel(tagDef, el), 'title[m,legislation]');
  });

  it('returns the bare tag when the variant attribute is absent on the element', () => {
    const tagDef = {
      tag: 'title',
      label: 'title',
      color: '#a6e3a1',
      attributes: [],
      variants: [{ attrs: { level: 'a' } }],
    };
    const el = document.createElement('title'); // no level attr
    assert.strictEqual(resolveLabel(tagDef, el), 'title');
  });

  it('returns plain label when the def has no variants', () => {
    const plain = { tag: 'bibl', label: 'bibl', color: '#89dceb', attributes: [], variants: [] };
    const el = document.createElement('bibl');
    assert.strictEqual(resolveLabel(plain, el), 'bibl');
  });

  it('returns plain label when variants is undefined (optional field)', () => {
    const plain = { tag: 'bibl', label: 'bibl', color: '#89dceb', attributes: [] };
    const el = document.createElement('bibl');
    assert.strictEqual(resolveLabel(plain, el), 'bibl');
  });
});

describe('createAnnotationField', () => {
  const tagDefs = [
    { tag: 'bibl', label: 'BIBL', color: '#89dceb', attributes: [] }
  ];
  // createAnnotationField returns [StateField, atomicRanges facet]; extract the field for state queries
  const extensions = createAnnotationField(tagDefs);
  const annotationField = extensions[0];

  function makeView(doc) {
    const parent = document.getElementById('editor');
    parent.innerHTML = '';
    return new EditorView({
      state: EditorState.create({ doc, extensions: [xml(), extensions] }),
      parent
    });
  }

  it('creates a StateField without throwing', () => {
    assert.doesNotThrow(() => makeView('<root><bibl>Smith 1987</bibl></root>'));
  });

  it('produces decorations for a known annotation tag', () => {
    const view = makeView('<root><bibl>Smith 1987</bibl></root>');
    const { decos } = view.state.field(annotationField);
    assert.ok(decos.size > 0, 'should produce at least one decoration for <bibl>');
  });
});

describe('createAnnotationField with empty elements', () => {
  const tagDefs = [
    { tag: 'gap', label: 'gap', color: '#f38ba8', attributes: [], empty: true }
  ];
  const extensions = createAnnotationField(tagDefs);
  const annotationField = extensions[0];

  function makeView(doc) {
    const parent = document.getElementById('editor');
    parent.innerHTML = '';
    return new EditorView({
      state: EditorState.create({ doc, extensions: [xml(), extensions] }),
      parent
    });
  }

  it('replaces a self-closing annotation element with an outlined badge', () => {
    const doc = '<root>a <gap reason="illegible"/> b</root>';
    const view = makeView(doc);
    const { decos, atomic } = view.state.field(annotationField);
    const from = doc.indexOf('<gap');
    const ranges = [];
    decos.between(0, doc.length, (f, t, value) => { ranges.push({ f, t, value }); });
    const badge = ranges.find(r => r.f === from);
    assert.ok(badge, 'a decoration starts at <gap/>');
    assert.strictEqual(badge.t, doc.indexOf('/>') + 2, 'it covers the whole self-closing tag');
    const dom = badge.value.spec.widget.toDOM();
    assert.ok(dom.classList.contains('ann-badge--empty'));
    assert.strictEqual(dom.dataset.tag, 'gap');
    let atomicAtGap = false;
    atomic.between(from, from + 1, () => { atomicAtGap = true; });
    assert.ok(!atomicAtGap, 'the badge replaces the tag instead of an atomic marker');
  });

  it('keeps self-closing elements without a tag definition as atomic tags', () => {
    const doc = '<root>a <lb/> b</root>';
    const view = makeView(doc);
    const { decos, atomic } = view.state.field(annotationField);
    assert.strictEqual(decos.size, 0);
    assert.strictEqual(atomic.size, 3);
  });
});

describe('createAnnotationField with nested badges', () => {
  const tagDefs = [
    { tag: 'p', label: 'p', color: '#94e2d5', attributes: [] },
    { tag: 'unclear', label: 'unclear', color: '#f38ba8', attributes: [] },
    { tag: 'lb', label: 'lb', color: '#89b4fa', attributes: [], empty: true },
  ];
  const extensions = createAnnotationField(tagDefs);

  for (const doc of [
    '<div><p><lb/>first line<lb/>second</p></div>',
    '<div><p><unclear>word</unclear> rest</p></div>',
    '<div><p>text<lb/></p></div>',
    '<div><p><lb/></p></div>',
  ]) {
    it(`builds decorations without a range ordering error for ${doc}`, () => {
      const parent = document.getElementById('editor');
      parent.innerHTML = '';
      assert.doesNotThrow(() => new EditorView({
        state: EditorState.create({ doc, extensions: [xml(), extensions] }),
        parent
      }));
    });
  }
});

describe('createAnnotationField with display-only elements', () => {
  const tagDefs = [
    { tag: 'text', label: 'text', color: '#89dceb', attributes: [], readOnly: true },
    { tag: 'front', label: 'front', color: '#f38ba8', attributes: [] },
  ];
  const extensions = createAnnotationField(tagDefs);
  const annotationField = extensions[0];

  it('renders a non-clickable badge without content mark and lets children be top-level', () => {
    const parent = document.getElementById('editor');
    parent.innerHTML = '';
    const doc = '<text><front>title</front> rest</text>';
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [xml(), extensions] }),
      parent
    });
    const ranges = [];
    view.state.field(annotationField).decos.between(0, doc.length, (f, t, value) => { ranges.push({ f, t, value }); });

    const textBadge = ranges.find(r => r.f === 0 && r.value.spec.widget);
    assert.ok(textBadge, 'a badge replaces <text>');
    const dom = textBadge.value.spec.widget.toDOM();
    assert.ok(dom.classList.contains('ann-badge--readonly'));
    let clicked = false;
    dom.addEventListener('ann-badge-click', () => { clicked = true; });
    dom.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.ok(!clicked, 'a read-only badge does not open the popup');

    const marks = ranges.filter(r => r.value.spec.class);
    assert.deepStrictEqual(marks.map(r => r.value.spec.class), ['ann-outer'],
      'only <front> is colored, as a top-level element');
    assert.strictEqual(marks[0].f, doc.indexOf('title'));

    const closeText = doc.indexOf('</text>');
    assert.ok(ranges.some(r => r.f === closeText && r.t === doc.length), '</text> is hidden');
  });
});

describe('createAnnotationField with incremental parsing', () => {
  const tagDefs = [{ tag: 'bibl', label: 'BIBL', color: '#89dceb', attributes: [] }];

  it('rebuilds decorations when the parser extends the syntax tree without a doc change (#826)', async () => {
    const { forceParsing, syntaxTree } = await import('@codemirror/language');
    const extensions = createAnnotationField(tagDefs);
    const annotationField = extensions[0];
    const count = 5000;
    const doc = '<root>' + '<bibl>Smith 1987</bibl>\n'.repeat(count) + '</root>';
    const parent = document.getElementById('editor');
    parent.innerHTML = '';
    // Start from an empty document and replace it in one transaction, as updateEditorFromNode
    // does, so the parse after the change is cut off by the parser's time budget
    const view = new EditorView({ state: EditorState.create({ doc: '', extensions: [xml(), extensions] }), parent });
    view.dispatch({ changes: { from: 0, to: 0, insert: doc } });
    const countBadges = () => {
      let n = 0;
      view.state.field(annotationField).decos.between(0, view.state.doc.length, (f, t, d) => {
        if (d.spec.widget) n++;
      });
      return n;
    };
    const before = countBadges();
    assert.ok(syntaxTree(view.state).length < doc.length, `precondition: tree incomplete (${syntaxTree(view.state).length}/${doc.length})`);
    forceParsing(view, view.state.doc.length, 1e9);
    assert.strictEqual(syntaxTree(view.state).length, doc.length);
    const after = countBadges();
    assert.ok(after >= count, `expected ${count}+ badges after full parse, got ${after} (before: ${before})`);
    view.destroy();
  });
});

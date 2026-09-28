#!/usr/bin/env node

/**
 * Unit tests for the document-rules ref-decoration CodeMirror extension.
 * @testCovers app/src/modules/document-rules-decorations.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { buildRefDecorations, createOverrideRefField, createOverrideRefClickHandler } from '../../../app/src/modules/document-rules-decorations.js';

// Real documents in this codebase write <ref target="..."/> as a
// self-closing element (SelfClosingTag in the lezer XML grammar), not as
// <ref target="...">...</ref> (OpenTag + CloseTag) - the decoration module
// must handle both tag shapes (see readTagName()/readAttributeSpans() in the
// module under test), so fixtures here use self-closing refs throughout.
const DOC = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="a"><p><ref target="https://example.com/a.md"/></p></interpretation>
    <interpretation type="b"><p><ref target="https://example.com/b.md"/></p></interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>`;

function makeState(doc = DOC) {
  return EditorState.create({ doc, extensions: [xml()] });
}

describe('buildRefDecorations', () => {
  it('finds one decoration per <ref target> element inside editorialDecl', () => {
    const state = makeState();
    const decos = buildRefDecorations(state, new Set());
    const ranges = [];
    decos.between(0, state.doc.length, (from, to) => ranges.push({ from, to }));
    assert.strictEqual(ranges.length, 2);
  });

  it('marks a URL in overriddenUrls with the overridden class', () => {
    const state = makeState();
    const decos = buildRefDecorations(state, new Set(['https://example.com/a.md']));
    const classes = [];
    decos.between(0, state.doc.length, (_f, _t, deco) => classes.push(deco.spec.class));
    assert.deepStrictEqual(classes.sort(), ['doc-rules-ref', 'doc-rules-ref doc-rules-ref-overridden']);
  });

  it('produces no decorations for a document with no <ref> elements', () => {
    const state = makeState('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>');
    const decos = buildRefDecorations(state, new Set());
    let count = 0;
    decos.between(0, state.doc.length, () => { count++; });
    assert.strictEqual(count, 0);
  });

  it('excludes the surrounding quotes from the decorated span', () => {
    const state = makeState();
    const decos = buildRefDecorations(state, new Set());
    let firstFrom = null, firstTo = null;
    decos.between(0, state.doc.length, (from, to) => { if (firstFrom === null) { firstFrom = from; firstTo = to; } });
    const text = state.doc.sliceString(firstFrom, firstTo);
    assert.strictEqual(text, 'https://example.com/a.md');
  });

  it('does not decorate a <ref target> element outside editorialDecl', () => {
    // A <ref target="..."> can legitimately appear elsewhere in a TEI
    // header (e.g. appInfo/application citing the extractor tool) - those
    // are unrelated to document rules and must not be decorated/clickable
    // (fixed in a follow-up after the plan's original draft; see
    // app/src/modules/document-rules-decorations.js's module doc-comment).
    const doc = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc><appInfo><application><ref target="https://example.com/tool.md"/></application></appInfo></encodingDesc>
    <encodingDesc><editorialDecl>
      <interpretation type="a"><p><ref target="https://example.com/a.md"/></p></interpretation>
    </editorialDecl></encodingDesc>
  </teiHeader>
</TEI>`;
    const state = makeState(doc);
    const decos = buildRefDecorations(state, new Set());
    const urls = [];
    decos.between(0, state.doc.length, (from, to) => urls.push(state.doc.sliceString(from, to)));
    assert.deepStrictEqual(urls, ['https://example.com/a.md']);
  });
});

describe('createOverrideRefField', () => {
  it('rebuilds decorations after a document change', () => {
    const field = createOverrideRefField(new Set());
    let state = EditorState.create({ doc: DOC, extensions: [xml(), field] });
    const tr = state.update({ changes: { from: state.doc.length, insert: '\n<!-- x -->' } });
    state = tr.state;
    const decos = state.field(field);
    let count = 0;
    decos.between(0, state.doc.length, () => { count++; });
    assert.strictEqual(count, 2, 'decorations must survive a document change unrelated to the refs');
  });
});

describe('createOverrideRefClickHandler', () => {
  // EditorView.domEventHandlers(handlers) returns a ViewPlugin extension
  // object, not the plain `handlers` object passed in - the registered
  // handler function lives at `.domEventHandlers.click` on the returned
  // ViewPlugin (verified against the actual @codemirror/view runtime value;
  // the plan's original draft assumed `.click` directly on the return
  // value, which does not match the real API shape).
  it('calls onRefClick with the marker\'s data-doc-rules-url and returns true when a decorated element is clicked', () => {
    let clickedUrl = null;
    const extension = createOverrideRefClickHandler((url) => { clickedUrl = url; });
    const marker = { getAttribute: (name) => (name === 'data-doc-rules-url' ? 'https://example.com/a.md' : null) };
    const target = { closest: (sel) => (sel === '.doc-rules-ref' ? marker : null) };
    const handled = extension.domEventHandlers.click.call(null, /** @type {any} */ ({ target }), /** @type {any} */ ({}));
    assert.strictEqual(clickedUrl, 'https://example.com/a.md');
    assert.strictEqual(handled, true);
  });

  it('returns false (lets the event through) when the click is not on a decorated element', () => {
    let called = false;
    const extension = createOverrideRefClickHandler(() => { called = true; });
    const target = { closest: () => null };
    const handled = extension.domEventHandlers.click.call(null, /** @type {any} */ ({ target }), /** @type {any} */ ({}));
    assert.strictEqual(called, false);
    assert.strictEqual(handled, false);
  });
});

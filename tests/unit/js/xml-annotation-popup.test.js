#!/usr/bin/env node

/**
 * Tests for mergeWithPrev / mergeWithNext and XmlAnnotationPopup exported from xml-annotation-popup.js.
 *
 * @testCovers app/src/modules/codemirror/xml-annotation-popup.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;
global.window = dom.window;

const { mergeWithPrev, mergeWithNext, XmlAnnotationPopup } = await import('../../../app/src/modules/codemirror/xml-annotation-popup.js');

/**
 * Build a parent <p> element whose innerHTML is set to `html`, then return
 * { parent, child } where `child` is the element with the given `id`.
 * @param {string} html
 * @param {string} id
 */
function build(html, id) {
  const parent = document.createElement('p');
  parent.innerHTML = html;
  const child = parent.querySelector(`#${id}`);
  if (!child) throw new Error(`element #${id} not found in "${html}"`);
  return { parent, child };
}

// ── mergeWithPrev ──────────────────────────────────────────────────────────

describe('mergeWithPrev', () => {
  it('preserves text content when merging into previous sibling', () => {
    const { parent, child } = build('<rs id="a">A</rs> and <rs id="b">B</rs>', 'b');
    const before = parent.textContent;
    mergeWithPrev(child);
    assert.strictEqual(parent.textContent, before, 'textContent must not change');
  });

  it('absorbs text nodes between siblings into the previous sibling', () => {
    const { parent, child } = build('<rs id="a">A</rs> and <rs id="b">B</rs>', 'b');
    mergeWithPrev(child);
    // parent should now contain only one <rs> with content "A and B"
    assert.strictEqual(parent.children.length, 1, 'only one element should remain');
    assert.strictEqual(parent.firstElementChild?.id, 'a');
    assert.strictEqual(parent.firstElementChild?.textContent, 'A and B');
    // no stray text node may remain in parent
    for (const n of parent.childNodes) {
      assert.notStrictEqual(n.nodeType, dom.window.Node.TEXT_NODE,
        `stray text node in parent: "${n.textContent}"`);
    }
  });

  it('handles no text node between siblings', () => {
    const { parent, child } = build('<rs id="a">A</rs><rs id="b">B</rs>', 'b');
    mergeWithPrev(child);
    assert.strictEqual(parent.children.length, 1);
    assert.strictEqual(parent.firstElementChild?.textContent, 'AB');
  });

  it('unwraps into parent when no previous element sibling', () => {
    const { parent, child } = build('before <rs id="b">B</rs> after', 'b');
    const before = parent.textContent;
    mergeWithPrev(child);
    assert.strictEqual(parent.textContent, before, 'textContent must not change');
    assert.strictEqual(parent.children.length, 0, 'element should be removed');
  });

  it('unwraps first child (no previous sibling, no preceding text)', () => {
    const { parent, child } = build('<rs id="a">A</rs> tail', 'a');
    const before = parent.textContent;
    mergeWithPrev(child);
    assert.strictEqual(parent.textContent, before);
    assert.strictEqual(parent.children.length, 0);
  });

  it('returns the parent node', () => {
    const { parent, child } = build('<rs id="a">A</rs><rs id="b">B</rs>', 'b');
    const result = mergeWithPrev(child);
    assert.strictEqual(result, parent);
  });

  it('preserves content of multi-child elements', () => {
    const { parent, child } = build('<rs id="a"><em>X</em>Y</rs> mid <rs id="b">B</rs>', 'b');
    const before = parent.textContent;
    mergeWithPrev(child);
    assert.strictEqual(parent.textContent, before);
    assert.strictEqual(parent.children.length, 1);
  });
});

// ── mergeWithNext ──────────────────────────────────────────────────────────

describe('mergeWithNext', () => {
  it('preserves text content when merging into next sibling', () => {
    const { parent, child } = build('<rs id="a">A</rs> and <rs id="b">B</rs>', 'a');
    const before = parent.textContent;
    mergeWithNext(child);
    assert.strictEqual(parent.textContent, before, 'textContent must not change');
  });

  it('absorbs text nodes between siblings into the next sibling', () => {
    const { parent, child } = build('<rs id="a">A</rs> and <rs id="b">B</rs>', 'a');
    mergeWithNext(child);
    assert.strictEqual(parent.children.length, 1, 'only one element should remain');
    assert.strictEqual(parent.firstElementChild?.id, 'b');
    assert.strictEqual(parent.firstElementChild?.textContent, 'A and B');
    for (const n of parent.childNodes) {
      assert.notStrictEqual(n.nodeType, dom.window.Node.TEXT_NODE,
        `stray text node in parent: "${n.textContent}"`);
    }
  });

  it('handles no text node between siblings', () => {
    const { parent, child } = build('<rs id="a">A</rs><rs id="b">B</rs>', 'a');
    mergeWithNext(child);
    assert.strictEqual(parent.children.length, 1);
    assert.strictEqual(parent.firstElementChild?.textContent, 'AB');
  });

  it('prepends element content and intermediate text before existing content in next sibling', () => {
    const { parent, child } = build('<rs id="a">A</rs> mid <rs id="b">B</rs>', 'a');
    mergeWithNext(child);
    // " mid " text node between a and b is moved into b before b's original content
    assert.strictEqual(parent.firstElementChild?.textContent, 'A mid B');
  });

  it('unwraps into parent when no next element sibling', () => {
    const { parent, child } = build('before <rs id="a">A</rs> after', 'a');
    const before = parent.textContent;
    mergeWithNext(child);
    assert.strictEqual(parent.textContent, before, 'textContent must not change');
    assert.strictEqual(parent.children.length, 0, 'element should be removed');
  });

  it('unwraps last child (no next sibling, no trailing text)', () => {
    const { parent, child } = build('lead <rs id="a">A</rs>', 'a');
    const before = parent.textContent;
    mergeWithNext(child);
    assert.strictEqual(parent.textContent, before);
    assert.strictEqual(parent.children.length, 0);
  });

  it('returns the parent node', () => {
    const { parent, child } = build('<rs id="a">A</rs><rs id="b">B</rs>', 'a');
    const result = mergeWithNext(child);
    assert.strictEqual(result, parent);
  });

  it('preserves content of multi-child elements', () => {
    const { parent, child } = build('<rs id="a">A</rs> mid <rs id="b"><em>X</em>Y</rs>', 'a');
    const before = parent.textContent;
    mergeWithNext(child);
    assert.strictEqual(parent.textContent, before);
    assert.strictEqual(parent.children.length, 1);
  });
});

// ── XmlAnnotationPopup title resolution ───────────────────────────────────

/**
 * Dispatch ann-badge-click on `container` and return the popup overlay element.
 * @param {HTMLElement} container
 * @param {string} tag
 * @param {Element} domElement - returned by the mock editor's getDomNodeAt
 * @returns {HTMLElement|null}
 */
function triggerPopup(container, tag, domElement) {
  const mockEditor = {
    getDomNodeAt: () => domElement,
    updateEditorFromNode: async () => {}
  };
  const popup = new XmlAnnotationPopup(mockEditor);
  popup.mount(container, tagDefsWithDuplicates);
  container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
    bubbles: true,
    detail: { tag, from: 0, clientX: 10, clientY: 10 }
  }));
  return container.querySelector('.ann-popup');
}

const tagDefsWithDuplicates = [
  // generic bibl — no defaultAttributes, serves as fallback
  { tag: 'bibl', label: 'bibl',          color: '#aaa', attributes: [], defaultAttributes: null },
  // specific bibl for footnote entries — defaultAttributes distinguishes it
  { tag: 'bibl', label: 'bibl[footnote]', color: '#bbb', attributes: [], defaultAttributes: { type: 'footnote' } },
];

describe('XmlAnnotationPopup - popup title for duplicate tag defs', () => {
  it('shows generic label for <bibl> with no attributes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const bibl = document.createElement('bibl'); // no attributes
      const overlay = triggerPopup(container, 'bibl', bibl);
      const titleText = overlay?.querySelector('div')?.textContent ?? '';
      assert.ok(titleText.includes('bibl'), 'title should include tag name');
      assert.ok(!titleText.includes('footnote'),
        `title should NOT include "footnote" for <bibl> with no attributes, got: "${titleText}"`);
    } finally {
      document.body.removeChild(container);
    }
  });

  it('shows specific label for <bibl type="footnote">', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const bibl = document.createElement('bibl');
      bibl.setAttribute('type', 'footnote');
      const overlay = triggerPopup(container, 'bibl', bibl);
      const titleText = overlay?.querySelector('div')?.textContent ?? '';
      assert.ok(titleText.includes('footnote'),
        `title should include "footnote" for <bibl type="footnote">, got: "${titleText}"`);
    } finally {
      document.body.removeChild(container);
    }
  });
});

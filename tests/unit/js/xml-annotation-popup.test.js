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
 * @param {AnnotationTagDef[]} [tagDefs]
 * @returns {HTMLElement|null}
 */
function triggerPopup(container, tag, domElement, tagDefs = tagDefsWithVariants) {
  const mockEditor = {
    getDomNodeAt: () => domElement,
    updateEditorFromNode: async () => {}
  };
  const popup = new XmlAnnotationPopup(mockEditor);
  popup.mount(container, tagDefs);
  container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
    bubbles: true,
    detail: { tag, from: 0, clientX: 10, clientY: 10 }
  }));
  return container.querySelector('.ann-popup');
}

// One AnnotationTagDef per tag now (not one per attribute-value combination);
// attribute-value combinations live in `variants` instead.
const tagDefsWithVariants = [
  {
    tag: 'bibl',
    label: 'bibl',
    color: '#aaa',
    attributes: [],
    variants: [
      { attrs: { type: 'footnote' }, description: 'A footnote reference' },
      { attrs: { type: 'decision' } },
    ],
    bareAllowed: true,
    childTags: [],
  },
];

describe('XmlAnnotationPopup - popup title for a tag with variants', () => {
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

// ── XmlAnnotationPopup retag via "Change to" palette ───────────────────────

/**
 * Like triggerPopup, but returns a call trace of the mock editor's
 * updateEditorFromNode invocations alongside the popup overlay, so tests can
 * assert whether a retag actually happened (and whether it triggered an
 * editor sync).
 * @param {HTMLElement} container
 * @param {string} tag
 * @param {Element} domElement - returned by the mock editor's getDomNodeAt
 * @param {AnnotationTagDef[]} [tagDefs]
 * @returns {{ overlay: HTMLElement|null, calls: Node[] }}
 */
function triggerPopupTracked(container, tag, domElement, tagDefs = tagDefsWithVariants) {
  const calls = /** @type {Node[]} */ ([]);
  const mockEditor = {
    getDomNodeAt: () => domElement,
    updateEditorFromNode: async (/** @type {Node} */ node) => { calls.push(node); }
  };
  const popup = new XmlAnnotationPopup(mockEditor);
  popup.mount(container, tagDefs);
  container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
    bubbles: true,
    detail: { tag, from: 0, clientX: 10, clientY: 10 }
  }));
  return { overlay: container.querySelector('.ann-popup'), calls };
}

/**
 * Finds the top-level chip <span> (not a dropdown menu item, not the
 * wrapper span, not the caret) whose textContent exactly matches `label`.
 * Chip spans have no children (their textContent is just the label), while
 * the wrapper span's textContent also includes the caret glyph — so an
 * exact match against the bare tag name distinguishes them.
 * @param {HTMLElement} overlay
 * @param {string} label
 */
function findChip(overlay, label) {
  const spans = [...overlay.querySelectorAll('span')];
  const chip = spans.find((s) => s.textContent === label);
  if (!chip) {
    throw new Error(`chip "${label}" not found among: ${spans.map((s) => s.textContent).join(', ')}`);
  }
  return chip;
}

/**
 * Finds an `sl-menu-item` dropdown entry by its exact `tag[value,...]` text.
 * @param {HTMLElement} overlay
 * @param {string} text
 */
function findMenuItem(overlay, text) {
  const items = [...overlay.querySelectorAll('sl-menu-item')];
  const item = items.find((i) => i.textContent === text);
  if (!item) {
    throw new Error(`menu item "${text}" not found among: ${items.map((i) => i.textContent).join(', ')}`);
  }
  return item;
}

describe('XmlAnnotationPopup - retag via "Change to" palette', () => {
  it('clicking a dropdown variant sets the attribute on the same tag', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl'); // bare, no attributes
      parent.appendChild(bibl);
      const { overlay } = triggerPopupTracked(container, 'bibl', bibl);
      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[footnote]');
      item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(parent.children.length, 1, 'exactly one element remains in parent');
      const result = parent.firstElementChild;
      assert.strictEqual(result?.localName, 'bibl');
      assert.strictEqual(result?.getAttribute('type'), 'footnote');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('clicking the bare chip body removes an attribute set by a previous variant', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl');
      bibl.setAttribute('type', 'footnote');
      parent.appendChild(bibl);
      const { overlay } = triggerPopupTracked(container, 'bibl', bibl);
      const chip = findChip(/** @type {HTMLElement} */ (overlay), 'bibl');
      chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      const result = parent.firstElementChild;
      assert.strictEqual(result?.localName, 'bibl');
      assert.strictEqual(result?.hasAttribute('type'), false,
        'type attribute must be fully removed when clicking the bare chip');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('clicking the currently-active variant\'s own item is a genuine no-op', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl');
      bibl.setAttribute('type', 'footnote'); // this variant is "active"
      parent.appendChild(bibl);
      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl);
      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[footnote]');
      item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(parent.children.length, 1);
      const result = parent.firstElementChild;
      assert.strictEqual(result?.getAttribute('type'), 'footnote', 'attribute must remain unchanged');
      assert.strictEqual(calls.length, 0, 'updateEditorFromNode must not be called for a genuine no-op');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('clicking the bare chip body when already bare is a genuine no-op', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl'); // already bare
      parent.appendChild(bibl);
      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl);
      const chip = findChip(/** @type {HTMLElement} */ (overlay), 'bibl');
      chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(parent.firstElementChild?.hasAttribute('type'), false);
      assert.strictEqual(calls.length, 0, 'updateEditorFromNode must not be called for a genuine no-op');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('switching to a different variant (not bare, not the active one) updates the attribute', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl');
      bibl.setAttribute('type', 'footnote');
      parent.appendChild(bibl);
      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl);
      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[decision]');
      item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(parent.firstElementChild?.getAttribute('type'), 'decision');
      assert.strictEqual(calls.length, 1, 'updateEditorFromNode must be called for a real change');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('a tag with no variants renders a plain chip with no dropdown', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const plainDefs = [
        { tag: 'author', label: 'author', color: '#ccc', attributes: [], variants: [], bareAllowed: true, childTags: [] },
      ];
      const parent = document.createElement('p');
      const author = document.createElement('author');
      parent.appendChild(author);
      const { overlay } = triggerPopupTracked(container, 'author', author, plainDefs);
      assert.strictEqual(overlay?.querySelectorAll('sl-dropdown').length, 0,
        'a tag with no variants must not render a dropdown');
      // chip body click is still a no-op here since the element is already bare and 'author' is bareAllowed
      findChip(/** @type {HTMLElement} */ (overlay), 'author');
    } finally {
      document.body.removeChild(container);
    }
  });

  // Regression test: mirrors the real `title` def generated for
  // grobid.training.references, whose variants have DIFFERENT attribute-key
  // sets: {level: 'a'} vs {level: 'm', type: 'legislation'}. Muting must
  // compare against the FULL set of variant-controlled attribute names
  // (variantAttrNames), not just the candidate variant's own keys — otherwise
  // {level: 'a'} would be wrongly treated as "active" for an element that
  // also has type="legislation", since checking only `level` never notices
  // the extra `type` attribute.
  it('mixed-key-set variants: only the variant matching ALL variant-controlled attributes is muted', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const mixedKeyDefs = [
        {
          tag: 'title',
          label: 'title',
          color: '#ddd',
          attributes: [],
          variants: [
            { attrs: { level: 'a' } },
            { attrs: { level: 'm', type: 'legislation' } },
          ],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const parent = document.createElement('p');
      const title = document.createElement('title');
      title.setAttribute('level', 'm');
      title.setAttribute('type', 'legislation'); // matches the SECOND variant exactly
      parent.appendChild(title);
      const { overlay, calls } = triggerPopupTracked(container, 'title', title, mixedKeyDefs);

      // First variant {level: 'a'} must NOT be muted: the element has an
      // extra `type` attribute this variant doesn't mention, so picking it
      // is a real change (strip type, set level='a').
      const firstItem = findMenuItem(/** @type {HTMLElement} */ (overlay), 'title[a]');
      assert.ok(!firstItem.disabled, 'first variant must not be disabled');
      firstItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(parent.firstElementChild?.getAttribute('level'), 'a');
      assert.strictEqual(parent.firstElementChild?.hasAttribute('type'), false,
        'type must be stripped when switching to the level-only variant');
      assert.strictEqual(calls.length, 1, 'clicking the non-active variant must trigger a real retag');

      // Reset and verify the second variant's own item IS muted (genuine no-op).
      const parent2 = document.createElement('p');
      const title2 = document.createElement('title');
      title2.setAttribute('level', 'm');
      title2.setAttribute('type', 'legislation');
      parent2.appendChild(title2);
      const { overlay: overlay2, calls: calls2 } = triggerPopupTracked(container, 'title', title2, mixedKeyDefs);
      const secondItem = findMenuItem(/** @type {HTMLElement} */ (overlay2), 'title[m,legislation]');
      secondItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(parent2.firstElementChild?.getAttribute('level'), 'm');
      assert.strictEqual(parent2.firstElementChild?.getAttribute('type'), 'legislation');
      assert.strictEqual(calls2.length, 0, 'clicking the already-active variant must be a genuine no-op');
    } finally {
      document.body.removeChild(container);
    }
  });

  // Regression coverage for `bareAllowed: false` (e.g. `citedRange`/`title`,
  // which the schema only ever allows with a required attribute): the chip
  // body must not itself apply a bare-tag no-attrs pick, and clicking it
  // must open the dropdown instead of being a dead click.
  it('bareAllowed:false chip body opens the dropdown instead of applying a bare pick', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const requiredAttrDefs = [
        {
          tag: 'citedRange',
          label: 'citedRange',
          color: '#eee',
          attributes: [],
          variants: [
            { attrs: { unit: 'page' } },
            { attrs: { unit: 'paragraph' } },
          ],
          bareAllowed: false,
          childTags: [],
        },
      ];
      const parent = document.createElement('p');
      const citedRange = document.createElement('citedRange'); // no attributes yet
      parent.appendChild(citedRange);
      const { overlay, calls } = triggerPopupTracked(container, 'citedRange', citedRange, requiredAttrDefs);

      const chip = findChip(/** @type {HTMLElement} */ (overlay), 'citedRange');
      const dropdown = overlay?.querySelector('sl-dropdown');
      assert.ok(dropdown, 'a bareAllowed:false tag with variants must still render a dropdown');
      chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(calls.length, 0, 'clicking the chip body must not apply a bare-tag pick');
      assert.strictEqual(/** @type {any} */ (dropdown).open, true,
        'clicking the chip body must open the dropdown when bareAllowed is false');

      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'citedRange[page]');
      item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(parent.firstElementChild?.getAttribute('unit'), 'page');
      assert.strictEqual(calls.length, 1, 'picking a variant from the dropdown must still apply normally');
    } finally {
      document.body.removeChild(container);
    }
  });
});

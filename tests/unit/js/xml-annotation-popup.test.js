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
global.Window = dom.window.Window;

const { mergeWithPrev, mergeWithNext, computeOverlayPosition, XmlAnnotationPopup } = await import('../../../app/src/modules/codemirror/xml-annotation-popup.js');

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

  // Regression test: the title must use the same name=value form as the
  // "Change to" dropdown's variant items (bibl[type=footnote], not
  // bibl[footnote]) — both disambiguating and matching the dropdown text.
  it('shows the title in name=value form, matching the "Change to" dropdown format', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const bibl = document.createElement('bibl');
      bibl.setAttribute('type', 'footnote');
      const overlay = triggerPopup(container, 'bibl', bibl);
      const titleText = overlay?.querySelector('div')?.textContent ?? '';
      assert.ok(titleText.includes('bibl[type=footnote]'),
        `expected title to include "bibl[type=footnote]", got: "${titleText}"`);
    } finally {
      document.body.removeChild(container);
    }
  });

  it('shows every variant-controlled attribute in the title, in name=value form, for a multi-attribute variant', () => {
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
      const title = document.createElement('title');
      title.setAttribute('level', 'm');
      title.setAttribute('type', 'legislation');
      const overlay = triggerPopup(container, 'title', title, mixedKeyDefs);
      const titleText = overlay?.querySelector('div')?.textContent ?? '';
      assert.ok(titleText.includes('title[level=m,type=legislation]'),
        `expected title to include "title[level=m,type=legislation]", got: "${titleText}"`);
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
 * @param {boolean} [readOnly] - if true, calls setReadOnly(true) before opening the popup
 * @returns {{ overlay: HTMLElement, calls: Node[] }}
 */
function triggerPopupTracked(container, tag, domElement, tagDefs = tagDefsWithVariants, readOnly = false) {
  const calls = /** @type {Node[]} */ ([]);
  const mockEditor = {
    getDomNodeAt: () => domElement,
    updateEditorFromNode: async (/** @type {Node} */ node) => { calls.push(node); }
  };
  const popup = new XmlAnnotationPopup(mockEditor);
  popup.mount(container, tagDefs);
  if (readOnly) popup.setReadOnly(true);
  container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
    bubbles: true,
    detail: { tag, from: 0, clientX: 10, clientY: 10 }
  }));
  const overlay = container.querySelector('.ann-popup');
  if (!overlay) throw new Error('popup overlay did not render');
  return { overlay, calls };
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
      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[type=footnote]');
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
      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[type=footnote]');
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
      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[type=decision]');
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
      const firstItem = findMenuItem(/** @type {HTMLElement} */ (overlay), 'title[level=a]');
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
      const secondItem = findMenuItem(/** @type {HTMLElement} */ (overlay2), 'title[level=m,type=legislation]');
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

      const item = findMenuItem(/** @type {HTMLElement} */ (overlay), 'citedRange[unit=page]');
      item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(parent.firstElementChild?.getAttribute('unit'), 'page');
      assert.strictEqual(calls.length, 1, 'picking a variant from the dropdown must still apply normally');
    } finally {
      document.body.removeChild(container);
    }
  });
});

// ── XmlAnnotationPopup editable attributes ─────────────────────────────────

describe('XmlAnnotationPopup - editable attributes', () => {
  // Regression test: for a variant whose schema root tag IS the annotation
  // tag itself (e.g. `bibl` for grobid.training.references — see
  // annotation_tags_scope.py's `"root": "bibl"`), the badge's element is the
  // XML document's root element, so `element.parentNode` is the Document
  // node. `linkSyntaxTreeWithDOM` (codemirror-utils.js) only links from the
  // root *Element* down — the Document node itself is never added to the
  // dom<->syntax position maps — so calling updateEditorFromNode with
  // `element.parentNode` throws "Dom node has no attached syntax node" in
  // xmleditor.js. The element itself is always tracked (it came from
  // getDomNodeAt), so the fix is to update from `element`, not its parent —
  // which is also correct for nested (non-root) elements since editing an
  // attribute doesn't restructure the parent's children.
  it('updateEditorFromNode is called with the element itself, not its parent, when editing an enumerated attribute', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'type', values: ['footnote', 'decision'] }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const xmlDoc = document.implementation.createDocument(null, 'bibl', null);
      const bibl = xmlDoc.documentElement;
      bibl.setAttribute('type', 'footnote');
      assert.strictEqual(bibl.parentNode, xmlDoc, 'sanity check: root element\'s parent is the Document');

      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs);
      const select = overlay?.querySelector('sl-select');
      assert.ok(select, 'an sl-select must render for an enumerated attribute');
      /** @type {any} */ (select).value = 'decision';
      select.dispatchEvent(new dom.window.CustomEvent('sl-change', { bubbles: true }));

      assert.strictEqual(calls.length, 1, 'updateEditorFromNode must be called once');
      assert.strictEqual(calls[0], bibl,
        'must be called with the element itself, not its parentNode (the untracked Document for a root element)');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('updateEditorFromNode is called with the element itself, not its parent, when editing a freeform attribute', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'corresp', values: null }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const xmlDoc = document.implementation.createDocument(null, 'bibl', null);
      const bibl = xmlDoc.documentElement;

      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs);
      const input = overlay?.querySelector('sl-input');
      assert.ok(input, 'an sl-input must render for a freeform attribute');
      /** @type {any} */ (input).value = '#ref1';
      input.dispatchEvent(new dom.window.CustomEvent('sl-change', { bubbles: true }));

      assert.strictEqual(calls.length, 1, 'updateEditorFromNode must be called once');
      assert.strictEqual(calls[0], bibl,
        'must be called with the element itself, not its parentNode (the untracked Document for a root element)');
    } finally {
      document.body.removeChild(container);
    }
  });

  // Regression test for the real bug: XmlEditorDomSync rebuilds its DOM<->
  // syntax-tree maps from a freshly re-parsed DOM 1 second after the last
  // document-changing transaction (xmleditor.js's #delayedUpdateActions
  // debounce), producing brand new Element objects even when nothing about
  // the document text changed. A popup routinely stays open longer than
  // that debounce window while the user reads it, so the Element captured
  // when the popup opened can be orphaned by the time a deferred action
  // (attribute edit, merge, remove, retag) actually runs. The popup must
  // re-resolve the live element at action time via getDomNodeAt(from),
  // not reuse the one captured at open time.
  it('re-resolves the live element at action time instead of reusing the one captured when the popup opened', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'type', values: ['footnote', 'decision'] }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      // Two distinct Element objects standing in for "the same document
      // position, before and after a domSync resync" — a real resync
      // re-parses the text into a brand new Document, so even an otherwise
      // identical element is a different object afterward.
      const staleDoc = document.implementation.createDocument(null, 'bibl', null);
      const staleEl = staleDoc.documentElement;
      staleEl.setAttribute('type', 'footnote');

      const freshDoc = document.implementation.createDocument(null, 'bibl', null);
      const freshEl = freshDoc.documentElement;
      freshEl.setAttribute('type', 'footnote');

      let getDomNodeAtCalls = 0;
      const calls = /** @type {Node[]} */ ([]);
      const mockEditor = {
        // First resolution (popup opening) returns the "stale" element;
        // every subsequent resolution (the deferred sl-change handler)
        // returns the "fresh" one — simulating a resync in between.
        getDomNodeAt: () => { getDomNodeAtCalls += 1; return getDomNodeAtCalls === 1 ? staleEl : freshEl; },
        updateEditorFromNode: async (/** @type {Node} */ node) => { calls.push(node); },
      };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, defWithAttrs);
      container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
        bubbles: true,
        detail: { tag: 'bibl', from: 42, clientX: 10, clientY: 10 },
      }));

      const overlay = container.querySelector('.ann-popup');
      const select = overlay?.querySelector('sl-select');
      assert.ok(select, 'an sl-select must render for an enumerated attribute');
      /** @type {any} */ (select).value = 'decision';
      select.dispatchEvent(new dom.window.CustomEvent('sl-change', { bubbles: true }));

      assert.strictEqual(calls.length, 1, 'updateEditorFromNode must be called once');
      assert.strictEqual(calls[0], freshEl,
        'must act on the freshly re-resolved element, not the one captured when the popup opened');
      assert.notStrictEqual(calls[0], staleEl);
    } finally {
      document.body.removeChild(container);
    }
  });

  it('renders a delete button for an optional attribute and clears it on click', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'corresp', values: null, required: false }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl');
      bibl.setAttribute('corresp', '#ref1');
      parent.appendChild(bibl);

      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs);
      const input = overlay?.querySelector('sl-input');
      assert.ok(input, 'an sl-input must render for the freeform attribute');
      const row = /** @type {HTMLElement} */ (input).parentElement;
      const clearBtn = [...(row?.children ?? [])].find((el) => el.textContent === '✕');
      assert.ok(clearBtn, 'a delete button must render for an optional attribute');

      clearBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(bibl.hasAttribute('corresp'), false, 'attribute must be removed');
      assert.strictEqual(/** @type {any} */ (input).value, '', 'the control must be cleared too');
      assert.strictEqual(calls.length, 1, 'updateEditorFromNode must be called once');
      assert.strictEqual(calls[0], bibl);
    } finally {
      document.body.removeChild(container);
    }
  });

  it('does not render a delete button for a required attribute', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'corresp', values: null, required: true }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const bibl = document.createElement('bibl');
      bibl.setAttribute('corresp', '#ref1');

      const { overlay } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs);
      const input = overlay?.querySelector('sl-input');
      const row = /** @type {HTMLElement} */ (input).parentElement;
      const clearBtn = [...(row?.children ?? [])].find((el) => el.textContent === '✕');
      assert.strictEqual(clearBtn, undefined, 'a required attribute must not offer a delete button');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('treats a missing `required` field as required (no delete button), matching the backend default', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'corresp', values: null }], // no `required` field at all
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const bibl = document.createElement('bibl');
      bibl.setAttribute('corresp', '#ref1');

      const { overlay } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs);
      const input = overlay?.querySelector('sl-input');
      const row = /** @type {HTMLElement} */ (input).parentElement;
      const clearBtn = [...(row?.children ?? [])].find((el) => el.textContent === '✕');
      assert.strictEqual(clearBtn, undefined);
    } finally {
      document.body.removeChild(container);
    }
  });
});

// ── XmlAnnotationPopup - "Change to" variant label format ──────────────────

describe('XmlAnnotationPopup - "Change to" variant label format', () => {
  it('renders single-attribute variants as name=value, not the bare value', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const bibl = document.createElement('bibl');
      const overlay = triggerPopup(container, 'bibl', bibl);
      findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[type=footnote]');
      findMenuItem(/** @type {HTMLElement} */ (overlay), 'bibl[type=decision]');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('renders multi-attribute variants with each attribute disambiguated by name', () => {
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
      const title = document.createElement('title');
      const overlay = triggerPopup(container, 'title', title, mixedKeyDefs);
      findMenuItem(/** @type {HTMLElement} */ (overlay), 'title[level=a]');
      findMenuItem(/** @type {HTMLElement} */ (overlay), 'title[level=m,type=legislation]');
    } finally {
      document.body.removeChild(container);
    }
  });
});

// ── XmlAnnotationPopup - read-only mode (issue #420) ────────────────────────

describe('XmlAnnotationPopup - read-only mode', () => {
  it('disables the merge/remove action buttons and does not mutate on click', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const prev = document.createElement('bibl');
      const bibl = document.createElement('bibl');
      parent.append(prev, bibl);
      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl, tagDefsWithVariants, true);

      const removeBtn = [...overlay.querySelectorAll('sl-button')].find((b) => b.textContent.includes('Remove'));
      assert.ok(removeBtn, 'remove button must still render');
      assert.strictEqual(/** @type {any} */ (removeBtn).disabled, true, 'remove button must be disabled');

      removeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(parent.children.length, 2, 'element must not be removed while read-only');
      assert.strictEqual(calls.length, 0, 'updateEditorFromNode must not be called while read-only');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('disables attribute edit controls and does not mutate on change', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'type', values: ['footnote', 'decision'] }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const bibl = document.createElement('bibl');
      bibl.setAttribute('type', 'footnote');
      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs, true);

      const select = overlay.querySelector('sl-select');
      assert.ok(select, 'an sl-select must still render');
      assert.strictEqual(/** @type {any} */ (select).hasAttribute('disabled'), true, 'select must be disabled');

      /** @type {any} */ (select).value = 'decision';
      select.dispatchEvent(new dom.window.CustomEvent('sl-change', { bubbles: true }));

      assert.strictEqual(bibl.getAttribute('type'), 'footnote', 'attribute must not change while read-only');
      assert.strictEqual(calls.length, 0, 'updateEditorFromNode must not be called while read-only');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('does not render the attribute delete button', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const defWithAttrs = [
        {
          tag: 'bibl',
          label: 'bibl',
          color: '#aaa',
          attributes: [{ name: 'corresp', values: null, required: false }],
          variants: [],
          bareAllowed: true,
          childTags: [],
        },
      ];
      const bibl = document.createElement('bibl');
      bibl.setAttribute('corresp', '#ref1');
      const { overlay } = triggerPopupTracked(container, 'bibl', bibl, defWithAttrs, true);

      const input = overlay.querySelector('sl-input');
      const row = /** @type {HTMLElement} */ (input).parentElement;
      const clearBtn = [...(row?.children ?? [])].find((el) => el.textContent === '✕');
      assert.strictEqual(clearBtn, undefined, 'delete button must not render while read-only');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('does not retag when a "Change to" dropdown variant is clicked', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const parent = document.createElement('p');
      const bibl = document.createElement('bibl');
      parent.appendChild(bibl);
      const { overlay, calls } = triggerPopupTracked(container, 'bibl', bibl, tagDefsWithVariants, true);

      // No click listener attached while read-only, so dispatching a click must be a no-op.
      const item = [...overlay.querySelectorAll('sl-menu-item')].find((i) => i.textContent === 'bibl[type=footnote]');
      assert.ok(item, 'variant item must still render (view-only)');
      item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(bibl.hasAttribute('type'), false, 'element must not be retagged while read-only');
      assert.strictEqual(calls.length, 0, 'updateEditorFromNode must not be called while read-only');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('does not wrap the selection via the "Annotate as…" palette', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      let wrapCalls = 0;
      const mockEditor = { getDomNodeAt: () => null, updateEditorFromNode: async () => {} };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, tagDefsWithVariants);
      popup.setWrapCallback(() => { wrapCalls += 1; });
      popup.setReadOnly(true);
      popup.showForSelection({ clientX: 10, clientY: 10 }, 0, 3);

      const overlay = /** @type {HTMLElement} */ (container.querySelector('.ann-popup'));
      const chip = [...overlay.querySelectorAll('span')].find((s) => s.textContent === 'bibl');
      assert.ok(chip, 'chip must still render in the selection palette');
      chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      assert.strictEqual(wrapCalls, 0, 'wrap callback must not fire while read-only');
    } finally {
      document.body.removeChild(container);
    }
  });
});

// ── computeOverlayPosition ───────────────────────────────────────────────

describe('computeOverlayPosition', () => {
  it('places the overlay below and to the right of the anchor by default', () => {
    const { left, top } = computeOverlayPosition({
      x: 100, y: 100, width: 200, height: 150, viewportWidth: 1024, viewportHeight: 768,
    });
    assert.strictEqual(left, 100);
    assert.strictEqual(top, 112); // y + default offset (12)
  });

  it('flips to the left of the anchor when the default placement would overflow the right edge', () => {
    const { left } = computeOverlayPosition({
      x: 900, y: 100, width: 200, height: 150, viewportWidth: 1024, viewportHeight: 768,
    });
    // default placement (x=900, width=200) would end at 1100, past the 1024 viewport
    assert.strictEqual(left, 900 - 200);
  });

  it('flips above the anchor when the default placement would overflow the bottom edge', () => {
    const { top } = computeOverlayPosition({
      x: 100, y: 700, width: 200, height: 150, viewportWidth: 1024, viewportHeight: 768,
    });
    // default placement (y=700+12, height=150) would end at 862, past the 768 viewport
    assert.strictEqual(top, 700 - 150 - 12);
  });

  it('clamps to the viewport edges when the overlay is larger than the available space', () => {
    const { left, top } = computeOverlayPosition({
      x: 900, y: 700, width: 2000, height: 2000, viewportWidth: 1024, viewportHeight: 768,
    });
    assert.ok(left >= 8, 'left must not be negative past the margin');
    assert.ok(top >= 8, 'top must not be negative past the margin');
  });

  it('never positions the overlay past the right or bottom edge, however it flips', () => {
    const { left, top } = computeOverlayPosition({
      x: 1000, y: 750, width: 300, height: 250, viewportWidth: 1024, viewportHeight: 768,
    });
    assert.ok(left + 300 <= 1024, `left+width (${left + 300}) must fit in viewport`);
    assert.ok(top + 250 <= 768, `top+height (${top + 250}) must fit in viewport`);
  });
});

// ── XmlAnnotationPopup - viewport-aware positioning ─────────────────────────

describe('XmlAnnotationPopup - viewport-aware positioning', () => {
  it('flips the popup left/up when opened near the bottom-right corner of the viewport', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      const bibl = document.createElement('bibl');
      const mockEditor = { getDomNodeAt: () => bibl, updateEditorFromNode: async () => {} };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, tagDefsWithVariants);
      const overlay = /** @type {HTMLElement} */ (container.querySelector('.ann-popup'));

      // jsdom has no layout engine (offsetWidth/offsetHeight are always 0), so
      // stub a realistic popup size to exercise the flip/clamp logic.
      Object.defineProperty(overlay, 'offsetWidth', { value: 220, configurable: true });
      Object.defineProperty(overlay, 'offsetHeight', { value: 260, configurable: true });

      container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
        bubbles: true,
        detail: { tag: 'bibl', from: 0, clientX: 1000, clientY: 750 },
      }));

      const left = parseFloat(overlay.style.left);
      const top = parseFloat(overlay.style.top);
      assert.ok(left + 220 <= window.innerWidth, `popup must fit horizontally, left=${left}`);
      assert.ok(top + 260 <= window.innerHeight, `popup must fit vertically, top=${top}`);
      assert.notStrictEqual(overlay.style.visibility, 'hidden', 'popup must end up visible');
    } finally {
      document.body.removeChild(container);
    }
  });
});

// ── XmlAnnotationPopup - follows editor scroll ──────────────────────────────

describe('XmlAnnotationPopup - follows editor scroll', () => {
  // `scroll` events don't bubble, and in the real app it's an ANCESTOR of
  // CodeMirror's own view.scrollDOM (app.css's #codemirror-container) that
  // actually has overflow:auto and scrolls — not view.scrollDOM itself. So
  // these tests dispatch the (non-bubbling) scroll event on some nested,
  // document-attached element standing in for that ancestor, to verify the
  // window-level capture:true listener (see #trackScroll) still catches it.
  it('repositions the popup on editor scroll using coordsAtPos for the tracked position', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const scrollableAncestor = document.createElement('div');
    container.appendChild(scrollableAncestor);
    try {
      const bibl = document.createElement('bibl');
      let coords = { left: 50, top: 40, bottom: 60, right: 100 };
      const mockView = { coordsAtPos: () => coords };
      const mockEditor = {
        getDomNodeAt: () => bibl,
        updateEditorFromNode: async () => {},
        getView: () => mockView,
      };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, tagDefsWithVariants);
      const overlay = /** @type {HTMLElement} */ (container.querySelector('.ann-popup'));

      container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
        bubbles: true,
        // clientX/clientY deliberately match the initial coordsAtPos() anchor's
        // left/bottom exactly, so offsetX/offsetY (see #trackScroll) are zero
        // and the scroll-time assertions below can compare against the raw
        // mocked coordsAtPos() values directly.
        detail: { tag: 'bibl', from: 5, clientX: 50, clientY: 60 },
      }));

      // Simulate the editor being scrolled: coordsAtPos for the SAME tracked
      // document position now resolves to a different on-screen location.
      coords = { left: 300, top: 400, bottom: 420, right: 350 };
      scrollableAncestor.dispatchEvent(new dom.window.Event('scroll')); // bubbles:false, like a real scroll event

      assert.strictEqual(parseFloat(overlay.style.left), 300);
      assert.strictEqual(parseFloat(overlay.style.top), 420 + 12, 'top follows coordsAtPos().bottom, plus the default offset');
    } finally {
      document.body.removeChild(container);
    }
  });

  // Regression test: a click on a badge lands wherever within its glyph, not
  // necessarily at the char box's left/bottom edge that coordsAtPos() always
  // returns — so naively repositioning to raw coordsAtPos() on the first
  // scroll tick would snap the popup sideways by that click-to-edge offset,
  // even though the editor only scrolled vertically. #trackScroll must
  // preserve the open-time offset between the click and the anchor instead.
  it('preserves the open-time click offset from the anchor when scrolling, instead of snapping to the raw anchor', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const scrollableAncestor = document.createElement('div');
    container.appendChild(scrollableAncestor);
    try {
      const bibl = document.createElement('bibl');
      // Anchor's left/bottom vs. the click point 15px right / 8px above it —
      // simulating a click that landed mid-badge, not at its exact edge.
      let coords = { left: 50, top: 40, bottom: 60, right: 100 };
      const mockView = { coordsAtPos: () => coords };
      const mockEditor = {
        getDomNodeAt: () => bibl,
        updateEditorFromNode: async () => {},
        getView: () => mockView,
      };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, tagDefsWithVariants);
      const overlay = /** @type {HTMLElement} */ (container.querySelector('.ann-popup'));

      container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
        bubbles: true,
        detail: { tag: 'bibl', from: 5, clientX: 65, clientY: 52 }, // anchor.left+15, anchor.bottom-8
      }));
      assert.strictEqual(parseFloat(overlay.style.left), 65, 'sanity check: opens at the click point, not the anchor');

      // Scroll vertically only — a real editor's coordsAtPos() would also
      // return the SAME left/right for a purely vertical scroll.
      coords = { left: 50, top: 280, bottom: 300, right: 100 };
      scrollableAncestor.dispatchEvent(new dom.window.Event('scroll'));

      // left must shift by the SAME 15px the popup opened with, not snap to
      // the anchor's raw (unchanged) left=50.
      assert.strictEqual(parseFloat(overlay.style.left), 65, 'x must not jump on a purely vertical scroll');
      assert.strictEqual(parseFloat(overlay.style.top), 300 - 8 + 12, 'y must track the anchor, offset by the original click-to-anchor delta');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('hides the popup once the tracked position scrolls out of the rendered viewport', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const scrollableAncestor = document.createElement('div');
    container.appendChild(scrollableAncestor);
    try {
      const bibl = document.createElement('bibl');
      let coords = /** @type {any} */ ({ left: 50, top: 40, bottom: 60, right: 100 });
      const mockView = { coordsAtPos: () => coords };
      const mockEditor = {
        getDomNodeAt: () => bibl,
        updateEditorFromNode: async () => {},
        getView: () => mockView,
      };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, tagDefsWithVariants);
      const overlay = /** @type {HTMLElement} */ (container.querySelector('.ann-popup'));

      container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
        bubbles: true,
        // clientX/clientY deliberately match the initial coordsAtPos() anchor's
        // left/bottom exactly, so offsetX/offsetY (see #trackScroll) are zero
        // and the scroll-time assertions below can compare against the raw
        // mocked coordsAtPos() values directly.
        detail: { tag: 'bibl', from: 5, clientX: 50, clientY: 60 },
      }));

      // CodeMirror's coordsAtPos() returns null for a position that isn't
      // currently rendered (scrolled far enough out of view).
      coords = null;
      scrollableAncestor.dispatchEvent(new dom.window.Event('scroll'));

      assert.strictEqual(overlay.style.display, 'none');
    } finally {
      document.body.removeChild(container);
    }
  });

  it('stops tracking scroll once the popup is hidden', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const scrollableAncestor = document.createElement('div');
    container.appendChild(scrollableAncestor);
    try {
      const bibl = document.createElement('bibl');
      let coords = { left: 50, top: 40, bottom: 60, right: 100 };
      const mockView = { coordsAtPos: () => coords };
      const mockEditor = {
        getDomNodeAt: () => bibl,
        updateEditorFromNode: async () => {},
        getView: () => mockView,
      };
      const popup = new XmlAnnotationPopup(mockEditor);
      popup.mount(container, tagDefsWithVariants);
      const overlay = /** @type {HTMLElement} */ (container.querySelector('.ann-popup'));

      container.dispatchEvent(new dom.window.CustomEvent('ann-badge-click', {
        bubbles: true,
        // clientX/clientY deliberately match the initial coordsAtPos() anchor's
        // left/bottom exactly, so offsetX/offsetY (see #trackScroll) are zero
        // and the scroll-time assertions below can compare against the raw
        // mocked coordsAtPos() values directly.
        detail: { tag: 'bibl', from: 5, clientX: 50, clientY: 60 },
      }));

      // Click outside the popup to hide it (registered in mount()).
      document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(overlay.style.display, 'none', 'sanity check: popup is hidden');

      const leftBefore = overlay.style.left;
      coords = { left: 999, top: 999, bottom: 999, right: 999 };
      assert.doesNotThrow(() => scrollableAncestor.dispatchEvent(new dom.window.Event('scroll')));
      assert.strictEqual(overlay.style.left, leftBefore, 'a scroll event after hide must not reposition the popup');
    } finally {
      document.body.removeChild(container);
    }
  });
});

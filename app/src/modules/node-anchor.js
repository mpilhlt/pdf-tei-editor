/**
 * Anchors of stand-off data on elements: an XPath to the element plus a fingerprint of its content
 * (see docs/user-manual/unit-comments.md).
 *
 * The XPath has one step per element from the root, with a position in brackets only where the
 * parent has several children of that name: `/TEI/text/back/listBibl/bibl[3]`. Namespace prefixes
 * are left out. The fingerprint is the one of unit review (see `canonicalForm()` in unit-review.js).
 *
 * An anchor is resolved in this order: the element at a position known from the current editing
 * session, the element at the XPath if its fingerprint matches, the element of the same name
 * with that fingerprint closest to the XPath, and finally the element at the XPath if it has the
 * expected name (its content was edited). Otherwise the anchor is detached.
 *
 * This module has no dependency on the application, so it can be unit-tested in node.
 *
 * @import { EditorState } from '@codemirror/state'
 * @import { SyntaxNode } from '@lezer/common'
 */

import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { canonicalForm, fingerprintOf, elementName } from './unit-review.js';

/**
 * A stored anchor
 * @typedef {object} Anchor
 * @property {string|null} path - XPath of the element
 * @property {string|null} fingerprint - Fingerprint of its content, null if unknown
 */

/**
 * An element an anchor resolved to
 * @typedef {object} AnchoredElement
 * @property {number} from - Start of the element
 * @property {number} to - End of the element
 * @property {number} tagTo - End of its start tag
 * @property {string} name - Local name
 * @property {string} path - Its current XPath
 * @property {string} fingerprint - Its current fingerprint
 * @property {'session'|'exact'|'moved'|'edited'} match - How it was found
 */

/**
 * Returns a reader for the document text.
 * @param {EditorState} state
 * @returns {(from: number, to: number) => string}
 */
function reader(state) {
  return (from, to) => state.doc.sliceString(from, to);
}

/**
 * Returns the child elements of an element (or of the top node).
 * @param {SyntaxNode} node
 * @returns {SyntaxNode[]}
 */
function childElements(node) {
  return node.getChildren('Element');
}

/**
 * Returns the innermost element containing a position, outside `TEI/standOff`.
 * @param {EditorState} state
 * @param {number} pos
 * @returns {SyntaxNode|null}
 */
export function elementAt(state, pos) {
  const read = reader(state);
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  /** @type {SyntaxNode|null} */
  let node = tree.resolveInner(Math.min(pos, state.doc.length), 1);
  while (node && node.name !== 'Element') node = node.parent;
  if (!node) return null;
  // nothing in the stand-off data itself
  for (let p = /** @type {SyntaxNode|null} */ (node); p; p = p.parent) {
    if (p.name === 'Element' && elementName(p, read) === 'standOff' && p.parent?.parent?.name === 'Document') return null;
  }
  return node;
}

/**
 * Returns the XPath of an element.
 * @param {SyntaxNode} element
 * @param {(from: number, to: number) => string} read
 * @returns {string}
 */
export function elementPath(element, read) {
  /** @type {string[]} */
  const steps = [];
  for (let node = /** @type {SyntaxNode|null} */ (element); node && node.name === 'Element'; node = node.parent) {
    const name = elementName(node, read) ?? '*';
    const parent = node.parent;
    const siblings = parent ? childElements(parent).filter(s => elementName(s, read) === name) : [node];
    const index = siblings.findIndex(s => s.from === node?.from);
    steps.unshift(siblings.length > 1 ? `${name}[${index + 1}]` : name);
  }
  return '/' + steps.join('/');
}

/**
 * Finds the element at an XPath of the form written by {@link elementPath}.
 * @param {EditorState} state
 * @param {string} path
 * @returns {SyntaxNode|null}
 */
export function elementByPath(state, path) {
  const read = reader(state);
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  /** @type {SyntaxNode} */
  let node = tree.topNode;
  for (const step of path.split('/').filter(Boolean)) {
    const match = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(step);
    if (!match) return null;
    const name = /** @type {string} */ (match[1]).split(':').pop();
    const index = match[2] ? Number(match[2]) - 1 : 0;
    const next = childElements(node).filter(el => elementName(el, read) === name)[index];
    if (!next) return null;
    node = next;
  }
  return node.name === 'Element' ? node : null;
}

/**
 * Returns the last step's element name of an XPath.
 * @param {string} path
 * @returns {string|null}
 */
function lastName(path) {
  const step = path.split('/').filter(Boolean).pop();
  return step ? step.replace(/\[\d+\]$/, '').split(':').pop() ?? null : null;
}

/**
 * Computes element fingerprints, cached by the element's raw text.
 */
export class FingerprintCache {
  /** @type {Map<string, string>} */
  #cache = new Map();

  /**
   * @param {SyntaxNode} element
   * @param {(from: number, to: number) => string} read
   * @returns {string}
   */
  get(element, read) {
    const raw = read(element.from, element.to);
    let fp = this.#cache.get(raw);
    if (!fp) {
      if (this.#cache.size > 5000) this.#cache.clear();
      fp = fingerprintOf(canonicalForm(element, read));
      this.#cache.set(raw, fp);
    }
    return fp;
  }
}

/**
 * Describes an element for {@link AnchoredElement}.
 * @param {SyntaxNode} node
 * @param {(from: number, to: number) => string} read
 * @param {FingerprintCache} cache
 * @param {AnchoredElement['match']} match
 * @returns {AnchoredElement}
 */
function describe(node, read, cache, match) {
  const tag = node.getChild('OpenTag') ?? node.getChild('SelfClosingTag');
  return {
    from: node.from,
    to: node.to,
    tagTo: tag?.to ?? node.to,
    name: elementName(node, read) ?? '',
    path: elementPath(node, read),
    fingerprint: cache.get(node, read),
    match
  };
}

/**
 * Resolves an anchor in the current document.
 * @param {EditorState} state
 * @param {Anchor} anchor
 * @param {FingerprintCache} cache
 * @param {number|null} [sessionPos] - Start of the element as tracked through the edits of this session
 * @returns {AnchoredElement|null} Null if the anchor is detached
 */
export function resolveAnchor(state, anchor, cache, sessionPos = null) {
  const read = reader(state);
  const name = anchor.path ? lastName(anchor.path) : null;
  if (sessionPos !== null && sessionPos <= state.doc.length) {
    const node = elementAt(state, sessionPos);
    if (node && node.from === sessionPos && (!name || elementName(node, read) === name)) {
      return describe(node, read, cache, 'session');
    }
  }
  if (!anchor.path) return null;
  const atPath = elementByPath(state, anchor.path);
  if (atPath && anchor.fingerprint && cache.get(atPath, read) === anchor.fingerprint) {
    return describe(atPath, read, cache, 'exact');
  }
  if (anchor.fingerprint && name) {
    const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
    const near = atPath?.from ?? 0;
    /** @type {SyntaxNode|null} */
    let best = null;
    tree.iterate({
      enter: ref => {
        if (ref.name !== 'Element') return undefined;
        const node = ref.node;
        if (elementName(node, read) === 'standOff' && node.parent?.parent?.name === 'Document') return false;
        if (elementName(node, read) === name && cache.get(node, read) === anchor.fingerprint) {
          if (!best || Math.abs(node.from - near) < Math.abs(best.from - near)) best = node;
        }
        return undefined;
      }
    });
    if (best) return describe(best, read, cache, 'moved');
  }
  if (atPath && elementName(atPath, read) === name) return describe(atPath, read, cache, 'edited');
  return null;
}

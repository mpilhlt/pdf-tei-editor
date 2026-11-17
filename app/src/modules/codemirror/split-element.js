/**
 * Splits the XML element that contains a position into two sibling elements.
 *
 * Works on the CodeMirror XML syntax tree, so it needs no DOM sync and does not depend on the
 * navigation XPath. The second element gets a copy of the opening tag of the first one, minus its
 * `xml:id` attribute, which must stay unique. Optionally, the second element starts on a new line.
 *
 * @import { EditorState, TransactionSpec } from '@codemirror/state'
 * @import { SyntaxNode } from '@lezer/common'
 */

import { syntaxTree } from '@codemirror/language';

/** Syntax nodes inside which the document cannot be split. */
const UNSPLITTABLE = new Set([
  'OpenTag', 'CloseTag', 'SelfClosingTag', 'MismatchedCloseTag', 'Comment', 'ProcessingInst',
  'Cdata', 'EntityReference', 'CharacterReference', 'DoctypeDecl'
]);

/**
 * @typedef {object} SplitTarget
 * @property {string} tagName - The name of the element that is split
 * @property {number} pos - The position at which it is split
 * @property {string} insert - The text inserted at `pos`: the closing tag and the new opening tag
 */

/**
 * @typedef {object} SplitOptions
 * @property {boolean} [newLine] - Start the second element on a new line, indented like the line
 *   on which the first element starts
 */

/**
 * Returns the child of `node` with the given name, if any.
 * @param {SyntaxNode} node
 * @param {string} name
 * @returns {SyntaxNode|null}
 */
function childNamed(node, name) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

/**
 * Finds the element that can be split at `pos` and the text that splits it.
 * Returns null if `pos` is inside markup (a tag, comment, entity etc.), outside any element, inside
 * the root element (splitting it would leave two root elements), or in an element whose tags the
 * parser could not match.
 * @param {EditorState} state
 * @param {number} pos
 * @param {SplitOptions} [options]
 * @returns {SplitTarget|null}
 */
export function findSplitTarget(state, pos, options = {}) {
  /** @type {SyntaxNode|null} */
  let node = syntaxTree(state).resolveInner(pos, 0);
  for (let n = node; n; n = n.parent) {
    if (UNSPLITTABLE.has(n.name)) return null;
  }
  while (node && node.name !== 'Element') node = node.parent;
  if (!node || !node.parent || node.parent.name === 'Document') return null;

  const openTag = childNamed(node, 'OpenTag');
  const closeTag = childNamed(node, 'CloseTag');
  if (!openTag || !closeTag || pos < openTag.to || pos > closeTag.from) return null;
  const nameNode = childNamed(openTag, 'TagName');
  if (!nameNode) return null;
  const tagName = state.sliceDoc(nameNode.from, nameNode.to);

  // copy the opening tag without its xml:id attribute and the whitespace before it
  let openTagText = '';
  let copiedTo = openTag.from;
  for (let attr = openTag.firstChild; attr; attr = attr.nextSibling) {
    if (attr.name !== 'Attribute') continue;
    const attrName = childNamed(attr, 'AttributeName');
    if (!attrName || state.sliceDoc(attrName.from, attrName.to) !== 'xml:id') continue;
    let from = attr.from;
    while (from > copiedTo && /\s/.test(state.sliceDoc(from - 1, from))) from--;
    openTagText += state.sliceDoc(copiedTo, from);
    copiedTo = attr.to;
  }
  openTagText += state.sliceDoc(copiedTo, openTag.to);

  const lineBreak = options.newLine
    ? '\n' + (/^[ \t]*/.exec(state.doc.lineAt(openTag.from).text)?.[0] ?? '')
    : '';
  return { tagName, pos, insert: `</${tagName}>${lineBreak}${openTagText}` };
}

/**
 * Returns the transaction that splits the element containing `pos`, with the cursor at the start
 * of the content of the new second element, or null if no element can be split there.
 * @param {EditorState} state
 * @param {number} pos
 * @param {SplitOptions} [options]
 * @returns {TransactionSpec|null}
 */
export function splitElementAt(state, pos, options = {}) {
  const target = findSplitTarget(state, pos, options);
  if (!target) return null;
  return {
    changes: { from: target.pos, insert: target.insert },
    selection: { anchor: target.pos + target.insert.length },
    userEvent: 'input',
    scrollIntoView: true
  };
}

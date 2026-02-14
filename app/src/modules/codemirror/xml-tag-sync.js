// @ts-check

import { EditorState, Annotation } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/**
 * @typedef {import("@codemirror/state").ChangeSpec} ChangeSpec
 * @typedef {import("@codemirror/state").Transaction} Transaction
 * @typedef {import("@codemirror/state").TransactionSpec} TransactionSpec
 * @typedef {import("@lezer/common").SyntaxNode} SyntaxNode
 */

/** Annotation used to mark mirror-sync transactions so the filter skips them. */
const tagSyncAnnotation = Annotation.define();

/**
 * Given an Element node and one of its direct tag children (OpenTag or CloseTag),
 * finds the TagName node of the counterpart tag.
 *
 * Only examines direct children of the Element node (via firstChild/nextSibling)
 * to avoid incorrectly matching nested elements' tags. Compares by position
 * rather than object identity, since Lezer's `.node` getter creates a new
 * SyntaxNode instance on every access.
 *
 * Accepts both `CloseTag` and `MismatchedCloseTag` because the Lezer XML parser
 * reclassifies close tags when the names don't match.
 *
 * @param {SyntaxNode} parentNode  - The OpenTag or CloseTag containing the edited TagName.
 * @param {SyntaxNode} element     - The Element node (grandparent of the edited TagName).
 * @param {boolean}    isOpenTag   - Whether the edit is in an OpenTag.
 * @returns {SyntaxNode | null}    - The matching TagName node, or null if not found.
 */
function findMatchingTagNameNode(parentNode, element, isOpenTag) {
  const targetTypes = isOpenTag
    ? ["CloseTag", "MismatchedCloseTag"]
    : ["OpenTag"];

  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (targetTypes.includes(child.name) && child.from !== parentNode.from) {
      for (let gc = child.firstChild; gc; gc = gc.nextSibling) {
        if (gc.name === "TagName") {
          return gc;
        }
      }
    }
  }

  return null;
}

/**
 * Resolves a TagName node at or near position `pos` in the given tree.
 * Tries forward bias first, then backward bias.
 *
 * @param {import("@lezer/common").Tree} tree
 * @param {number} pos
 * @returns {SyntaxNode | null}
 */
function resolveTagName(tree, pos) {
  for (const bias of [1, -1]) {
    let node = tree.resolveInner(pos, bias);
    while (node && node.name !== "TagName" && node.parent) {
      node = node.parent;
    }
    if (node && node.name === "TagName") return node;
  }
  return null;
}

/**
 * A CodeMirror 6 extension that keeps an XML element's opening and closing tag
 * names in sync as the user types.
 *
 * Implemented as a `transactionFilter` rather than a `ViewPlugin` so that the
 * mirror change is folded into the **same transaction** as the user's edit.
 * This avoids timing issues with deferred dispatches (`requestAnimationFrame`)
 * and the "Calls to EditorView.update are not allowed while an update is in
 * progress" restriction on `ViewPlugin.update()`.
 *
 * The filter inspects the pre-edit syntax tree (from `tr.startState`) to locate
 * the edited TagName and its counterpart. It then computes the new tag name text
 * from the post-edit document (`tr.state.doc`) and appends a mirror change to
 * the transaction.
 *
 * @type {import("@codemirror/state").Extension}
 */
export const xmlTagSync = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(tagSyncAnnotation)) return tr;

  const startState = tr.startState;
  const tree = syntaxTree(startState);

  /** @type {ChangeSpec[]} */
  const mirrorChanges = [];

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    // fromA/toA are positions in the OLD document.
    const node = resolveTagName(tree, fromA);
    if (!node) return;

    const parentNode = node.parent;
    if (!parentNode) return;

    const isOpenTag =
      parentNode.name === "OpenTag" ||
      parentNode.name === "SelfClosingTag";
    const isCloseTag =
      parentNode.name === "CloseTag" ||
      parentNode.name === "MismatchedCloseTag";

    if (!isOpenTag && !isCloseTag) return;

    const element = parentNode.parent;
    if (!element) return;

    // Compute the new tag name from the POST-edit document by mapping the
    // old TagName boundaries through the transaction's changes.
    const newFrom = tr.changes.mapPos(node.from, -1);
    const newTo = tr.changes.mapPos(node.to, 1);
    const newTagName = tr.state.doc.sliceString(newFrom, newTo);
    if (!newTagName.trim()) return;

    // Find the counterpart tag in the old tree.
    const match = findMatchingTagNameNode(parentNode, element, isOpenTag);
    if (!match) return;

    // Check against the old matching tag text to avoid no-ops.
    const oldMatchText = startState.doc.sliceString(match.from, match.to);
    if (oldMatchText === newTagName) return;

    // Map the match positions to the new document coordinates.
    const matchNewFrom = tr.changes.mapPos(match.from, -1);
    const matchNewTo = tr.changes.mapPos(match.to, 1);

    mirrorChanges.push({ from: matchNewFrom, to: matchNewTo, insert: newTagName });
  });

  if (mirrorChanges.length === 0) return tr;

  // Return the original transaction plus the mirror changes. The second spec's
  // positions are in the document produced by the first spec (sequential mode).
  return [tr, { changes: mirrorChanges, sequential: true }];
});

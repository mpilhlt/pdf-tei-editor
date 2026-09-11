// @ts-check

/**
 * Pure editing helpers for the XML annotation plugin.
 *
 * @import { EditorState } from '@codemirror/state'
 */

import { syntaxTree } from '@codemirror/language'

/**
 * Scans the selection range `[from, to)` for annotation elements that the
 * selection only partially covers — i.e. an element whose open tag lies before
 * `from` while its close tag lies inside the selection, or whose open tag lies
 * inside the selection while its close tag lies after `to`.
 *
 * Wrapping such a selection in a new element verbatim would emit overlapping
 * XML (e.g. `<title>Der</author> "x"</title>`). This helper computes the pieces
 * needed to avoid that: the dangling close/open tags are moved out of the
 * selected text — close tags emitted *before* the new wrapper, open tags *after*
 * it — and `cleanedText` is the selected source with those tag spans removed.
 *
 * @param {EditorState} state
 * @param {number} from - selection start (document offset)
 * @param {number} to - selection end (document offset)
 * @param {Set<string> | string[]} tagNames - annotation tag names to consider
 * @returns {{ prepend: string, append: string, cleanedText: string } | null}
 *   `null` when the selection covers no annotation element only partially.
 */
export function relocatePartialAnnotationTags(state, from, to, tagNames) {
  const tagSet = tagNames instanceof Set ? tagNames : new Set(tagNames)
  const doc = state.doc

  /** @type {Array<{ start: number, end: number }>} tag spans to remove from the selected text */
  const cuts = []
  /** @type {Array<{ openFrom: number, text: string }>} dangling close tags, moved before the wrapper */
  const closeTags = []
  /** @type {Array<{ openFrom: number, text: string }>} dangling open tags, moved after the wrapper */
  const openTags = []

  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== 'Element') return
      const el = node.node
      const openTag = el.firstChild
      if (openTag?.name !== 'OpenTag') return
      const tagNameNode = openTag.firstChild?.nextSibling
      if (tagNameNode?.name !== 'TagName') return
      const tagName = doc.sliceString(tagNameNode.from, tagNameNode.to)
      if (!tagSet.has(tagName)) return
      const closeTag = el.lastChild
      if (!closeTag || (closeTag.name !== 'CloseTag' && closeTag.name !== 'MismatchedCloseTag')) return

      if (openTag.from < from && closeTag.from >= from && closeTag.to <= to) {
        // Dangling close tag: element opens before the selection, closes inside it.
        cuts.push({ start: closeTag.from, end: closeTag.to })
        closeTags.push({ openFrom: openTag.from, text: `</${tagName}>` })
      } else if (openTag.from >= from && openTag.to <= to && closeTag.to > to) {
        // Dangling open tag: element opens inside the selection, closes after it.
        cuts.push({ start: openTag.from, end: openTag.to })
        openTags.push({ openFrom: openTag.from, text: doc.sliceString(openTag.from, openTag.to) })
      }
    },
  })

  if (cuts.length === 0) return null

  cuts.sort((a, b) => a.start - b.start)
  let cleanedText = ''
  let cursor = from
  for (const cut of cuts) {
    cleanedText += doc.sliceString(cursor, cut.start)
    cursor = cut.end
  }
  cleanedText += doc.sliceString(cursor, to)

  // Close tags are re-emitted innermost-first (deepest element = largest openFrom);
  // open tags are re-emitted outermost-first so nesting stays valid.
  closeTags.sort((a, b) => b.openFrom - a.openFrom)
  openTags.sort((a, b) => a.openFrom - b.openFrom)

  return {
    prepend: closeTags.map(t => t.text).join(''),
    append: openTags.map(t => t.text).join(''),
    cleanedText,
  }
}

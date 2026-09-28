/**
 * CodeMirror decorations for <ref target="..."> URLs inside a TEI
 * document's editorialDecl/interpretation entries: colors a ref's target
 * differently when the current user has an override selected for that
 * resource, and reports clicks on a decorated ref so the caller can open
 * the document-rules resource editor for it.
 *
 * Mirrors app/src/modules/codemirror/xml-annotation-decorations.js's
 * syntax-tree-walk shape (Element/OpenTag/TagName/Attribute/AttributeName/
 * AttributeValue node names, and the firstChild.firstChild?.nextSibling
 * TagName lookup), narrowed to <ref>'s target attribute specifically rather
 * than a whole-element badge/mark.
 */

/**
 * @import {EditorState} from '@codemirror/state'
 * @import {DecorationSet} from '@codemirror/view'
 */

import { StateField, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/**
 * Read one element's attributes as {name, value, valueFrom, valueTo} spans,
 * with valueFrom/valueTo excluding the surrounding quote characters.
 * @param {import('@lezer/common').SyntaxNode} openTagNode
 * @param {EditorState} state
 * @returns {Array<{name: string, value: string, valueFrom: number, valueTo: number}>}
 */
function readAttributeSpans(openTagNode, state) {
  /** @type {Array<{name: string, value: string, valueFrom: number, valueTo: number}>} */
  const attrs = []
  let child = openTagNode.firstChild
  while (child) {
    if (child.name === 'Attribute') {
      const nameNode = child.firstChild
      const valueNode = child.lastChild
      if (nameNode && valueNode && nameNode !== valueNode && nameNode.name === 'AttributeName') {
        const name = state.doc.sliceString(nameNode.from, nameNode.to)
        const raw = state.doc.sliceString(valueNode.from, valueNode.to)
        const value = raw.length >= 2 ? raw.slice(1, -1) : raw
        attrs.push({ name, value, valueFrom: valueNode.from + 1, valueTo: valueNode.to - 1 })
      }
    }
    child = child.nextSibling
  }
  return attrs
}

/**
 * Walk the whole syntax tree once, building one mark decoration per
 * <ref target="..."> found anywhere in the document, colored by whether its
 * target URL is in `overriddenUrls`.
 * @param {EditorState} state
 * @param {Set<string>} overriddenUrls
 * @returns {DecorationSet}
 */
export function buildRefDecorations(state, overriddenUrls) {
  const builder = new RangeSetBuilder()
  const tree = syntaxTree(state)
  /** @type {Array<{from: number, to: number, url: string, overridden: boolean}>} */
  const found = []

  tree.iterate({
    enter(node) {
      if (node.name !== 'Element') return
      const openTag = node.node.firstChild
      if (!openTag || openTag.name !== 'OpenTag') return
      const tagNameNode = openTag.firstChild?.nextSibling
      if (!tagNameNode || tagNameNode.name !== 'TagName') return
      const tagName = state.doc.sliceString(tagNameNode.from, tagNameNode.to)
      if (tagName !== 'ref') return
      for (const attr of readAttributeSpans(openTag, state)) {
        if (attr.name === 'target' && attr.valueFrom < attr.valueTo) {
          found.push({
            from: attr.valueFrom,
            to: attr.valueTo,
            url: attr.value,
            overridden: overriddenUrls.has(attr.value)
          })
        }
      }
    }
  })

  found.sort((a, b) => a.from - b.from)
  for (const { from, to, overridden } of found) {
    builder.add(from, to, Decoration.mark({
      class: overridden ? 'doc-rules-ref doc-rules-ref-overridden' : 'doc-rules-ref',
      attributes: { 'data-doc-rules-url': found.find(f => f.from === from)?.url ?? '' }
    }))
  }
  return builder.finish()
}

/** Visual styling for the two decoration classes. */
export const refDecorationTheme = EditorView.baseTheme({
  '.doc-rules-ref': {
    textDecoration: 'underline dotted',
    cursor: 'pointer'
  },
  '.doc-rules-ref-overridden': {
    textDecoration: 'underline solid',
    color: 'var(--sl-color-primary-600)',
    fontWeight: 'bold'
  }
})

/**
 * A StateField holding the current ref-decoration set for a fixed
 * `overriddenUrls` snapshot - rebuilt on every document change (matching
 * xml-annotation-decorations.js's own buildAll()'s whole-tree-walk-per-
 * change approach; acceptable at this feature's document sizes) and
 * whenever `overriddenUrls` itself changes, the caller reconfigures the
 * whole extension via a fresh createOverrideRefField() call rather than
 * pushing an effect into a long-lived field.
 * @param {Set<string>} overriddenUrls
 */
export function createOverrideRefField(overriddenUrls) {
  return StateField.define({
    create(state) {
      return buildRefDecorations(state, overriddenUrls)
    },
    update(decorations, tr) {
      return tr.docChanged ? buildRefDecorations(tr.state, overriddenUrls) : decorations.map(tr.changes)
    },
    provide: (field) => EditorView.decorations.from(field)
  })
}

/**
 * Build a click-handling extension: clicking a decorated <ref target="...">
 * span calls `onRefClick(url)`.
 * @param {(url: string) => void} onRefClick
 * @returns {import('@codemirror/state').Extension}
 */
export function createOverrideRefClickHandler(onRefClick) {
  return EditorView.domEventHandlers({
    click(event) {
      const target = /** @type {HTMLElement} */ (event.target)
      const marker = target.closest?.('.doc-rules-ref')
      if (!marker) return false
      const url = marker.getAttribute('data-doc-rules-url')
      if (url) onRefClick(url)
      return true
    }
  })
}

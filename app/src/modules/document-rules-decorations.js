/**
 * CodeMirror decorations for the document-rules registry's URLs in a TEI
 * document's header: <ref target="..."> inside editorialDecl/interpretation
 * (interpretation-ref resources), and the document's schema location
 * (schema resource) however it's declared - either the <?xml-model href>
 * PI or, when that's absent, the <schemaRef target> fallback element (see
 * docs/development/tei-header-integrations.md's "Schema location"
 * section). Colors a decorated URL differently when the current user has
 * an override selected for that resource, and reports clicks on one so the
 * caller can open the document-rules resource editor for it.
 *
 * The editorialDecl/interpretation walk mirrors
 * app/src/modules/codemirror/xml-annotation-decorations.js's syntax-tree-
 * walk shape (Element/OpenTag/SelfClosingTag/TagName/Attribute/
 * AttributeName/AttributeValue node names, and the
 * firstChild.firstChild?.nextSibling TagName lookup), narrowed to <ref>'s
 * target attribute specifically rather than a whole-element badge/mark, and
 * scoped to only descend into <editorialDecl> (a <ref target="..."> can
 * legitimately appear elsewhere in a TEI header, e.g. citing the extractor
 * tool in appInfo/application - those are unrelated to document rules and
 * must not be decorated/made clickable). The schema location is matched
 * against the raw document text instead (see XML_MODEL_RELAXNG_RE/
 * SCHEMA_REF_RE) - a PI isn't part of the syntax tree's Element/Attribute
 * nodes the way <ref>/<schemaRef> are, so decorating both the same way
 * keeps the two cases consistent rather than mixing a tree walk with a
 * regex for one and not the other.
 */

/**
 * @import {EditorState, Extension} from '@codemirror/state'
 * @import {DecorationSet} from '@codemirror/view'
 * @import {SyntaxNode} from '@lezer/common'
 */

import { StateField, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/**
 * Matches a RelaxNG `<?xml-model href="..." ... schematypens="...relaxng...">`
 * processing instruction, capturing its href. Mirrors (but does not import -
 * this is JS, that's Python) fastapi_app/lib/core/schema_validator.py's
 * extract_schema_locations() RelaxNG regex, so the "schema" resource this
 * decorates the same way document-rules.js's SchemaKind discovers it.
 * Processing instructions aren't structured into attribute nodes by the XML
 * language's syntax tree the way element attributes are (see
 * readAttributeSpans()), so this is matched against the raw document text
 * instead of walked via the syntax tree like <ref target> is.
 */
const XML_MODEL_RELAXNG_RE = /<\?xml-model\s+href="([^"]+)"[^>]*schematypens="http:\/\/relaxng\.org\/ns\/structure\/1\.0"[^>]*\?>/

/**
 * Matches a TEI `<schemaRef target="...">` element's target - the fallback
 * schema-location source `extract_schema_locations()` (schema_validator.py)
 * only consults when no xml-model PI is present (an existing PI stays
 * authoritative if a document somehow has both - see
 * docs/development/tei-header-integrations.md's "Schema location" section).
 * Mirrors that function's own regex, including its lack of any
 * encodingDesc-scoping.
 */
const SCHEMA_REF_RE = /<schemaRef\s+[^>]*target="([^"]+)"/

/**
 * Read one element's attributes as {name, value, valueFrom, valueTo} spans,
 * with valueFrom/valueTo excluding the surrounding quote characters.
 * @param {SyntaxNode} tagNode - an Element's OpenTag or SelfClosingTag child
 * @param {EditorState} state
 * @returns {Array<{name: string, value: string, valueFrom: number, valueTo: number}>}
 */
function readAttributeSpans(tagNode, state) {
  /** @type {Array<{name: string, value: string, valueFrom: number, valueTo: number}>} */
  const attrs = []
  let child = tagNode.firstChild
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
 * Read an Element node's tag name, from either its OpenTag or
 * SelfClosingTag child (both shapes place TagName as the second child,
 * after the `<` token).
 * @param {SyntaxNode} elementNode
 * @param {EditorState} state
 * @returns {{tagName: string, tagNode: SyntaxNode}|null}
 */
function readTagName(elementNode, state) {
  const tagNode = elementNode.firstChild
  if (!tagNode || (tagNode.name !== 'OpenTag' && tagNode.name !== 'SelfClosingTag')) return null
  const tagNameNode = tagNode.firstChild?.nextSibling
  if (!tagNameNode || tagNameNode.name !== 'TagName') return null
  return { tagName: state.doc.sliceString(tagNameNode.from, tagNameNode.to), tagNode }
}

/**
 * Walk the syntax tree, building one mark decoration per <ref target="...">
 * found inside <editorialDecl> (elements outside it, e.g. a <ref> in
 * appInfo/application citing the extractor tool, are intentionally not
 * decorated), colored by whether its target URL is in `overriddenUrls`.
 * Also decorates the document's schema location, the same way, whichever
 * form declares it: a RelaxNG `<?xml-model href="...">` PI (see
 * XML_MODEL_RELAXNG_RE) if present, else a `<schemaRef target="...">`
 * element (see SCHEMA_REF_RE) - it's the "schema" resource kind's
 * equivalent of an interpretation-ref's <ref>.
 * @param {EditorState} state
 * @param {Set<string>} overriddenUrls
 * @returns {DecorationSet}
 */
export function buildRefDecorations(state, overriddenUrls) {
  const builder = new RangeSetBuilder()
  const tree = syntaxTree(state)
  /** @type {Array<{from: number, to: number, url: string, overridden: boolean}>} */
  const found = []
  let editorialDeclDepth = 0

  tree.iterate({
    enter(node) {
      if (node.name !== 'Element') return
      const tag = readTagName(node.node, state)
      if (!tag) return
      if (tag.tagName === 'editorialDecl') {
        editorialDeclDepth++
        return
      }
      if (editorialDeclDepth === 0 || tag.tagName !== 'ref') return
      for (const attr of readAttributeSpans(tag.tagNode, state)) {
        if (attr.name === 'target' && attr.valueFrom < attr.valueTo) {
          found.push({
            from: attr.valueFrom,
            to: attr.valueTo,
            url: attr.value,
            overridden: overriddenUrls.has(attr.value)
          })
        }
      }
    },
    leave(node) {
      if (node.name !== 'Element') return
      const tag = readTagName(node.node, state)
      if (tag?.tagName === 'editorialDecl') editorialDeclDepth--
    }
  })

  const docText = state.doc.toString()
  const xmlModelMatch = XML_MODEL_RELAXNG_RE.exec(docText)
  if (xmlModelMatch) {
    const href = xmlModelMatch[1]
    const hrefStart = xmlModelMatch.index + xmlModelMatch[0].indexOf(`href="${href}"`) + 'href="'.length
    found.push({
      from: hrefStart,
      to: hrefStart + href.length,
      url: href,
      overridden: overriddenUrls.has(href)
    })
  } else {
    // Only consulted when there's no xml-model PI, mirroring
    // extract_schema_locations()'s own precedence.
    const schemaRefMatch = SCHEMA_REF_RE.exec(docText)
    if (schemaRefMatch) {
      const target = schemaRefMatch[1]
      const targetStart = schemaRefMatch.index + schemaRefMatch[0].indexOf(`target="${target}"`) + 'target="'.length
      found.push({
        from: targetStart,
        to: targetStart + target.length,
        url: target,
        overridden: overriddenUrls.has(target)
      })
    }
  }

  found.sort((a, b) => a.from - b.from)
  for (const { from, to, url, overridden } of found) {
    builder.add(from, to, Decoration.mark({
      class: overridden ? 'doc-rules-ref doc-rules-ref-overridden' : 'doc-rules-ref',
      attributes: { 'data-doc-rules-url': url }
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
 * @returns {StateField<DecorationSet>}
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
 * @returns {Extension}
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

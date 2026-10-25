/**
 * Stand-off lists of the editor: `TEI/standOff/listAnnotation[@type]` elements that tools keep
 * next to the annotation (unit review marks, unit comments).
 *
 * Works on the CodeMirror editor content (syntax tree and document text), so that a list is
 * always read from and written to the current text, and a write is one undoable edit.
 *
 * @import { EditorView } from '@codemirror/view'
 * @import { EditorState } from '@codemirror/state'
 * @import { SyntaxNode } from '@lezer/common'
 * @import { XMLEditor } from './xmleditor.js'
 */

import { syntaxTree, foldInside, foldedRanges, foldEffect } from '@codemirror/language'
import { Transaction } from '@codemirror/state'
import * as tei_utils from './tei-utils.js'
import { prettyPrintXmlDom } from './xml-utils.js'

export const TEI_NS = 'http://www.tei-c.org/ns/1.0'

/** One indentation level of the written lists */
const INDENT_UNIT = '  '

/**
 * Nodes of a stand-off list in the syntax tree
 * @typedef {object} StandOffLocation
 * @property {SyntaxNode|null} root - The root element
 * @property {SyntaxNode|null} teiHeader
 * @property {SyntaxNode|null} standOff - The first `standOff` child of the root
 * @property {SyntaxNode|null} list - Its `listAnnotation` child with the requested type
 */

/**
 * Serializes a list for writing: returns the `listAnnotation` element as text, starting with
 * `indent`, or null to remove the list.
 * @callback ListSerializer
 * @param {string} indent - Indentation of the `listAnnotation` element
 * @param {string} unit - One indentation level
 * @returns {string|null}
 */

/**
 * Returns the local name of an `Element` node.
 * @param {SyntaxNode} element
 * @param {(from: number, to: number) => string} read
 * @returns {string|null}
 */
export function tagName(element, read) {
  const tag = element.getChild('OpenTag') ?? element.getChild('SelfClosingTag')
  const nameNode = tag?.getChild('TagName')
  if (!nameNode) return null
  const name = read(nameNode.from, nameNode.to)
  return name.includes(':') ? /** @type {string} */ (name.split(':').pop()) : name
}

/**
 * Returns the value of an attribute of an `Element` node.
 * @param {SyntaxNode} element
 * @param {string} attribute
 * @param {(from: number, to: number) => string} read
 * @returns {string|null}
 */
export function attributeValue(element, attribute, read) {
  const tag = element.getChild('OpenTag') ?? element.getChild('SelfClosingTag')
  for (const attr of tag?.getChildren('Attribute') ?? []) {
    const name = attr.getChild('AttributeName')
    const value = attr.getChild('AttributeValue')
    if (name && value && read(name.from, name.to) === attribute) {
      return read(value.from, value.to).replace(/^["']|["']$/g, '')
    }
  }
  return null
}

/**
 * Finds `TEI/standOff/listAnnotation[@type=listType]` and related nodes in the syntax tree.
 * @param {EditorState} state
 * @param {string} listType
 * @returns {StandOffLocation}
 */
export function locateStandOffList(state, listType) {
  const read = (/** @type {number} */ from, /** @type {number} */ to) => state.doc.sliceString(from, to)
  /** @type {StandOffLocation} */
  const result = { root: null, teiHeader: null, standOff: null, list: null }
  const root = syntaxTree(state).topNode.getChild('Element')
  if (!root) return result
  result.root = root
  for (const child of root.getChildren('Element')) {
    const name = tagName(child, read)
    if (name === 'teiHeader') result.teiHeader = child
    if (name === 'standOff' && !result.standOff) {
      result.standOff = child
      for (const list of child.getChildren('Element')) {
        if (tagName(list, read) === 'listAnnotation' && attributeValue(list, 'type', read) === listType) {
          result.list = list
          break
        }
      }
    }
  }
  return result
}

/**
 * Parses a stand-off list of the editor content into a DOM element (a fresh copy).
 * @param {EditorState} state
 * @param {string} listType
 * @returns {Element|null} Null if there is no such list or it is not well-formed
 */
export function readStandOffList(state, listType) {
  const { list } = locateStandOffList(state, listType)
  if (!list) return null
  const text = state.doc.sliceString(list.from, list.to)
  const doc = new DOMParser().parseFromString(`<standOff xmlns="${TEI_NS}" xmlns:xml="http://www.w3.org/XML/1998/namespace">${text}</standOff>`, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) return null
  return doc.documentElement.firstElementChild
}

/**
 * Whether the content of an element is folded.
 * @param {EditorState} state
 * @param {SyntaxNode} node
 * @returns {boolean}
 */
export function isFolded(state, node) {
  const range = foldInside(node)
  if (!range) return false
  let folded = false
  foldedRanges(state).between(range.from, range.to, () => { folded = true; return false })
  return folded
}

/**
 * Replaces a stand-off list in the editor content in one transaction. A new list goes into the
 * existing `standOff`, or into a new `standOff` after the `teiHeader`; removing the last list
 * removes the `standOff`. A new `standOff` starts folded, a folded one stays folded.
 * @param {EditorView} view
 * @param {string} listType
 * @param {ListSerializer} serialize
 * @param {boolean} addToHistory - False for automatic changes the user should not undo separately
 * @returns {boolean} True if the content changed
 */
export function writeStandOffList(view, listType, serialize, addToHistory) {
  const state = view.state
  const located = locateStandOffList(state, listType)
  const indentOf = (/** @type {number} */ pos) => /^\s*/.exec(state.doc.lineAt(pos).text)?.[0] ?? ''
  const unit = INDENT_UNIT
  /** @type {{from: number, to?: number, insert: string}|null} */
  let change = null
  if (located.list) {
    const indent = indentOf(located.list.from)
    const text = serialize(indent, unit)
    if (text === null) {
      // remove the list, or the whole standOff if nothing else is in it
      const standOff = /** @type {SyntaxNode} */ (located.standOff)
      const onlyChild = standOff.getChildren('Element').length === 1
      const node = onlyChild ? standOff : located.list
      const lineStart = state.doc.lineAt(node.from).from
      const before = state.doc.sliceString(lineStart, node.from)
      const from = /^\s*$/.test(before) ? Math.max(0, lineStart - 1) : node.from
      change = { from, to: node.to, insert: '' }
    } else {
      change = { from: located.list.from, to: located.list.to, insert: text.slice(indent.length) }
    }
  } else if (located.standOff) {
    const text = serialize(indentOf(located.standOff.from) + unit, unit)
    if (text === null) return false
    const close = located.standOff.getChild('CloseTag')
    const at = close ? close.from : located.standOff.to
    const insert = text + '\n' + indentOf(located.standOff.from)
    // the close tag is usually preceded by the indentation of its own line
    const lineStart = state.doc.lineAt(at).from
    change = /^\s*$/.test(state.doc.sliceString(lineStart, at)) ? { from: lineStart, to: at, insert } : { from: at, insert }
  } else {
    const anchor = located.teiHeader ?? located.root?.getChild('OpenTag')
    if (!anchor) return false
    const indent = located.teiHeader ? indentOf(located.teiHeader.from) : unit
    const text = serialize(indent + unit, unit)
    if (text === null) return false
    change = { from: anchor.to, insert: `\n${indent}<standOff>\n${text}\n${indent}</standOff>` }
  }
  if (change.insert === state.doc.sliceString(change.from, change.to ?? change.from)) return false
  const keepFolded = !located.standOff || isFolded(state, located.standOff)
  view.dispatch({ changes: change, annotations: Transaction.addToHistory.of(addToHistory) })
  const standOff = locateStandOffList(view.state, listType).standOff
  const range = standOff && keepFolded ? foldInside(standOff) : null
  if (range && standOff && !isFolded(view.state, standOff)) view.dispatch({ effects: foldEffect.of(range) })
  return true
}

/**
 * Makes sure a user has a respStmt in the header, so that `@resp` and `@who` point somewhere.
 * @param {XMLEditor} xmlEditor
 * @param {{username: string, fullname?: string}|null|undefined} user
 * @param {string} resp - Responsibility, e.g. `Reviewer`
 * @returns {Promise<boolean>} True if a respStmt was added
 */
export async function ensureUserRespStmt(xmlEditor, user, resp) {
  if (!user) return false
  // the DOM tree is synced with a delay: bring it up to date, since it replaces the editor content
  await xmlEditor.sync()
  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc || tei_utils.getRespStmtById(xmlDoc, user.username)) return false
  tei_utils.ensureRespStmtForUser(xmlDoc, user.username, user.fullname || user.username, resp)
  prettyPrintXmlDom(xmlDoc, 'teiHeader')
  await xmlEditor.updateEditorFromXmlTree()
  return true
}

/**
 * Escapes text for XML content and attribute values.
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Removes the stand-off lists of a type (and a `standOff` left empty) from a TEI document.
 * @param {Document} xmlDoc
 * @param {string} listType
 * @returns {boolean} True if something was removed
 */
export function removeStandOffLists(xmlDoc, listType) {
  let removed = false
  for (const standOff of Array.from(xmlDoc.getElementsByTagNameNS('*', 'standOff'))) {
    for (const list of Array.from(standOff.children).filter(el => el.localName === 'listAnnotation')) {
      if (list.getAttribute('type') === listType) {
        list.remove()
        removed = true
      }
    }
    if (standOff.children.length === 0) {
      // drop the whitespace before it as well
      const prev = standOff.previousSibling
      if (prev && prev.nodeType === 3 && !(prev.textContent ?? '').trim()) prev.remove()
      standOff.remove()
    }
  }
  return removed
}

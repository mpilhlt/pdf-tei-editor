/**
 * Pure (no DOM, no Shoelace, no plugin framework deps) helpers for the
 * teiHeader editor: turn a /validate/teiheader-structure response into a
 * nested field tree a later task renders recursively.
 */

/**
 * @import { TeiHeaderStructureResponse, TeiHeaderTagDefinition, TeiHeaderAttribute } from './api-client-v1.js'
 */

const MAX_DEPTH = 6

/**
 * @typedef {Object} FieldNode
 * @property {string} tag
 * @property {string=} description
 * @property {boolean} isLeaf
 * @property {boolean} required
 * @property {boolean} repeatable
 * @property {Array<TeiHeaderAttribute>} attributes
 * @property {Array<FieldNode>} children
 * @property {HTMLElement=} el - set by TeiHeaderEditorPlugin#renderSection() at render time; absent until then
 */

/**
 * Build the nested field tree for every root in `structure.roots`.
 * @param {TeiHeaderStructureResponse} structure
 * @returns {Array<FieldNode>}
 */
export function buildFieldTree(structure) {
  return structure.roots.map((root) => buildNode(structure, root, true, false, new Set(), 0))
}

/**
 * @param {TeiHeaderStructureResponse} structure
 * @param {string} tag
 * @param {boolean} required
 * @param {boolean} repeatable
 * @param {Set<string>} ancestors - guards against a schema cycle (tag appearing in its own descendant chain)
 * @param {number} depth
 * @returns {FieldNode}
 */
function buildNode(structure, tag, required, repeatable, ancestors, depth) {
  /** @type {TeiHeaderTagDefinition|undefined} */
  const def = structure.tags[tag]
  const children = def?.children ?? []
  const atMaxDepth = depth >= MAX_DEPTH
  const isCycle = ancestors.has(tag)
  const isLeaf = children.length === 0 || atMaxDepth || isCycle

  /** @type {Array<FieldNode>} */
  let childNodes = []
  if (!isLeaf) {
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(tag)
    childNodes = children.map((childTag) => {
      const cardinality = def?.childCardinality?.[childTag] ?? { required: false, repeatable: false }
      return buildNode(structure, childTag, cardinality.required, cardinality.repeatable, nextAncestors, depth + 1)
    })
  }

  return {
    tag,
    description: def?.description,
    isLeaf,
    required,
    repeatable,
    attributes: def?.attributes ?? [],
    children: childNodes
  }
}

/**
 * @typedef {Object} FieldValue
 * @property {string} text
 * @property {Object<string, string>} attrs
 */

/** @typedef {Object<string, Array<FieldValue>|NestedFieldValues>} NestedFieldValues */

/**
 * Read current values for every direct child in `tree` out of `scopeNode`
 * (e.g. the live titleStmt/publicationStmt/sourceDesc DOM element, from
 * xmlEditorApi.getXmlTree()). A leaf child maps to an array of its existing
 * element instances (one entry per instance - a repeatable leaf may have
 * several, a non-repeatable one at most one); a non-leaf child maps to the
 * same shape recursively for ITS OWN children, scoped to its own matched
 * DOM element - NOT merged into the parent's own flat set of keys, so two
 * sibling sections sharing a leaf tag name never collide.
 * @param {Array<FieldNode>} tree
 * @param {Element} scopeNode
 * @returns {NestedFieldValues}
 */
export function readFieldValues(tree, scopeNode) {
  /** @type {NestedFieldValues} */
  const values = {}
  for (const node of tree) {
    if (node.isLeaf) {
      const matches = [...scopeNode.children].filter((el) => el.localName === node.tag)
      values[node.tag] = matches.map((el) => ({
        text: el.textContent ?? '',
        attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))
      }))
    } else {
      const child = [...scopeNode.children].find((el) => el.localName === node.tag)
      values[node.tag] = child ? readFieldValues(node.children, child) : {}
    }
  }
  return values
}

/**
 * Mutate `scopeNode` so it matches `values` (same nested shape
 * `readFieldValues()` returns), creating ancestor/leaf elements that don't
 * exist yet only for leaves present (non-empty) in `values` - a section the
 * user never touched gets no new elements. Each non-leaf child recurses
 * with ONLY its own nested slice of `values` (`values[node.tag]`), never
 * the parent's whole object - this is what keeps same-named leaves under
 * different parents independent (see this module's note on nesting above).
 * @param {Array<FieldNode>} tree
 * @param {Element} scopeNode
 * @param {NestedFieldValues} values
 * @param {string} namespaceUri
 */
export function applyFieldValues(tree, scopeNode, values, namespaceUri) {
  const doc = scopeNode.ownerDocument
  for (const node of tree) {
    if (node.isLeaf) {
      const existing = [...scopeNode.children].filter((el) => el.localName === node.tag)
      const wanted = /** @type {Array<FieldValue>} */ (values[node.tag] ?? []).filter((v) => v.text.trim() !== '')
      existing.forEach((el) => scopeNode.removeChild(el))
      for (const value of wanted) {
        const el = doc.createElementNS(namespaceUri, node.tag)
        el.textContent = value.text
        for (const [name, val] of Object.entries(value.attrs ?? {})) el.setAttribute(name, val)
        scopeNode.appendChild(el)
      }
    } else {
      const nestedValues = /** @type {NestedFieldValues} */ (values[node.tag] ?? {})
      const hasAnyValue = leavesHaveValues(node.children, nestedValues)
      let child = [...scopeNode.children].find((el) => el.localName === node.tag)
      if (child && !hasAnyValue) {
        // All values under this section were cleared - remove the now-empty
        // element rather than leaving a dangling `<imprint/>`-style husk,
        // mirroring how the leaf branch above already drops cleared leaves.
        scopeNode.removeChild(child)
        child = undefined
      } else if (!child && hasAnyValue) {
        child = doc.createElementNS(namespaceUri, node.tag)
        scopeNode.appendChild(child)
      }
      if (child) applyFieldValues(node.children, child, nestedValues, namespaceUri)
    }
  }
}

/**
 * True if any leaf anywhere under `tree` has a non-empty value in `values`
 * (same nested shape as `readFieldValues()`/`applyFieldValues()`) - used to
 * decide whether an optional section's DOM element needs to be created at
 * all. Exported so the plugin's save handler can reuse it instead of
 * re-deriving an equivalent (and easy to get subtly wrong, per this
 * module's nesting note above) check itself.
 * @param {Array<FieldNode>} tree
 * @param {NestedFieldValues} values
 * @returns {boolean}
 */
export function leavesHaveValues(tree, values) {
  return tree.some((node) =>
    node.isLeaf
      ? /** @type {Array<FieldValue>} */ (values[node.tag] ?? []).some((v) => v.text.trim() !== '')
      : leavesHaveValues(node.children, /** @type {NestedFieldValues} */ (values[node.tag] ?? {}))
  )
}

/**
 * The main value input of a rendered leaf row - the first `sl-input`/
 * `sl-textarea` element in the row, as produced by
 * TeiHeaderEditorPlugin#renderLeafRow() (the value input is always appended
 * before any per-attribute inputs). A row also holds one `sl-input`/
 * `sl-select` PER attribute (e.g. `title`'s `type` attribute renders as a
 * plain `sl-input` with `dataset.attr` set) - those must never be mistaken
 * for the row's own value, since an attribute can be filled in while the
 * leaf's actual text content is empty. Exported so both the plugin's
 * value-collection and required-field-validation code paths resolve "the"
 * input for a row identically and can't drift apart.
 * @param {Element} row
 * @returns {Element|null}
 */
export function getMainInput(row) {
  return row.querySelector('sl-input, sl-textarea')
}

/**
 * Pure (no DOM, no Shoelace, no plugin framework deps) helpers for the
 * teiHeader editor: turn a /validate/teiheader-structure response into a
 * nested field tree a later task renders recursively.
 */

/**
 * @import { TeiHeaderStructureResponse, TeiHeaderTagDefinition, TeiHeaderAttribute } from './api-client-v1.js'
 */

// The design spec calls for 6, but the bundled core TEI schema's real
// cross-referenced vocabulary makes that impractically large in practice
// even with buildNode()'s global-expand-once fix below (~1000 fields /
// ~50k DOM elements at depth 2 already; depth 3 alone was ~190k elements
// and failed to render reliably in E2E testing). Reduced to 2 as a
// pragmatic stopgap pending a proper fix (e.g. lazy/on-demand expansion,
// or curating which tags are worth exposing) - see
// tests/e2e/tests/tei-header-editor.spec.js's header comment for the full
// investigation this was found during.
export const MAX_DEPTH = 2

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
  // Shared across every root and never removed on backtrack (unlike a
  // per-branch ancestor-chain set) - see buildNode()'s docstring for why.
  const visited = new Set()
  return structure.roots.map((root) => buildNode(structure, root, true, false, visited, 0))
}

/**
 * `visited` guards against two distinct blow-ups: a genuine schema cycle
 * (a tag reachable from its own descendant chain, which would recurse
 * forever without a depth cap) AND - the actually dominant real-world
 * case for a TEI-sized schema - the SAME shared tag (e.g. `p`, `date`,
 * `idno`, `name`, any `att.global`-style attribute-bearing element) being
 * reachable as a child of MANY different parents. A per-branch ancestor
 * set (the old approach: copied and cycle-scoped per recursion path) only
 * catches the first case; every occurrence of a widely-shared tag still
 * gets its full subtree independently re-expanded down to MAX_DEPTH on
 * every single path that reaches it, which is combinatorial in a
 * real schema (empirically: the bundled core TEI schema's
 * titleStmt/publicationStmt/sourceDesc closure never finished building a
 * field tree within a 30s+ test timeout before this fix). `visited` is
 * instead a single Set mutated in place and shared across the WHOLE
 * `buildFieldTree()` call (every root, every branch): a tag's full
 * subtree is expanded at most ONCE, the first time it's encountered in
 * traversal order: every later reference to the same tag anywhere else
 * in the tree - a true cycle or a distant, unrelated reuse - becomes a
 * leaf immediately. This also doubles as a sane UX bound: a metadata form
 * re-rendering the same shared element's entire nested subtree over and
 * over under every parent that can contain it would be unusable anyway.
 * @param {TeiHeaderStructureResponse} structure
 * @param {string} tag
 * @param {boolean} required
 * @param {boolean} repeatable
 * @param {Set<string>} visited
 * @param {number} depth
 * @returns {FieldNode}
 */
function buildNode(structure, tag, required, repeatable, visited, depth) {
  /** @type {TeiHeaderTagDefinition|undefined} */
  const def = structure.tags[tag]
  const children = def?.children ?? []
  const atMaxDepth = depth >= MAX_DEPTH
  const alreadyExpanded = visited.has(tag)
  const isLeaf = children.length === 0 || atMaxDepth || alreadyExpanded

  /** @type {Array<FieldNode>} */
  let childNodes = []
  if (!isLeaf) {
    // Marked BEFORE recursing into children: a true self-cycle (tag
    // reachable from its own descendant chain) then immediately sees
    // itself as already-visited and stops, exactly like the old
    // per-branch ancestor check did.
    visited.add(tag)
    childNodes = children.map((childTag) => {
      const cardinality = def?.childCardinality?.[childTag] ?? { required: false, repeatable: false }
      return buildNode(structure, childTag, cardinality.required, cardinality.repeatable, visited, depth + 1)
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
        // Empty attribute inputs are skipped, not written as `attr=""` -
        // many of a leaf's rendered attribute inputs are optional (e.g.
        // TEI's global attributes: xml:id, xml:lang, rend, ...) and almost
        // always left blank; writing them anyway produces invalid XML for
        // NCName-typed attributes like xml:id (the empty string is not a
        // valid NCName) and pollutes the output with meaningless empty
        // attributes for every other one.
        for (const [name, val] of Object.entries(value.attrs ?? {})) {
          if (val.trim() !== '') el.setAttribute(name, val)
        }
        scopeNode.appendChild(el)
      }
    } else {
      const nestedValues = /** @type {NestedFieldValues} */ (values[node.tag] ?? {})
      const hasAnyValue = leavesHaveValues(node.children, nestedValues)
      let child = [...scopeNode.children].find((el) => el.localName === node.tag)
      // A non-leaf tag can, in a real document, hold plain text instead of
      // any of its schema-defined structural children (e.g.
      // `<publisher>Nomos Verlag</publisher>` with no `<orgName>`).
      // readFieldValues() never captures that text (it only looks for
      // matching child ELEMENTS - see its docstring), so `hasAnyValue` is
      // always false for such an element regardless of its real content.
      // Removing it on that basis would silently delete real data the
      // user never touched, on every save that reaches this section (see
      // tests/e2e/tests/tei-header-editor.spec.js's header comment,
      // finding #4). Full mixed-content editing (reading/writing that raw
      // text) stays a documented follow-up; this only stops the
      // destructive side effect by leaving such an element untouched.
      const hasUncapturedText = !!child && [...child.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== ''
      )
      if (child && !hasAnyValue && !hasUncapturedText) {
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

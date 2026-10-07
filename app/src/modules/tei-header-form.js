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

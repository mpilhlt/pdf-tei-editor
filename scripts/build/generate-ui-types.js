#!/usr/bin/env node
/**
 * Generates JSDoc typedef files from HTML templates.
 *
 * For each app/src/templates/*.html, generates app/src/templates/<name>.types.js
 * with @typedef declarations that mirror the createNavigableElement() hierarchy
 * produced at runtime by ui-system.js.
 *
 * Usage: node bin/generate-ui-types.js
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '..', 'app', 'src', 'templates')

/** @type {Record<string, string>} Shoelace/HTML tag → JSDoc type name */
const TAG_TYPE_MAP = {
  'sl-button': 'SlButton',
  'sl-button-group': 'SlButtonGroup',
  'sl-select': 'SlSelect',
  'sl-option': 'SlOption',
  'sl-menu': 'SlMenu',
  'sl-menu-item': 'SlMenuItem',
  'sl-dropdown': 'SlDropdown',
  'sl-input': 'SlInput',
  'sl-checkbox': 'SlCheckbox',
  'sl-dialog': 'SlDialog',
  'sl-drawer': 'SlDrawer',
  'sl-icon': 'SlIcon',
  'sl-icon-button': 'SlIconButton',
  'sl-tooltip': 'SlTooltip',
  'sl-switch': 'SlSwitch',
  'sl-divider': 'SlDivider',
  'sl-progress-bar': 'SlProgressBar',
  'sl-textarea': 'SlTextarea',
  'sl-tree': 'SlTree',
  'sl-tree-item': 'SlTreeItem',
  'sl-split-panel': 'SlSplitPanel',
  'div': 'HTMLDivElement',
  'span': 'HTMLSpanElement',
  'button': 'HTMLButtonElement',
  'input': 'HTMLInputElement',
  'select': 'HTMLSelectElement',
}

/** HTML void elements that cannot have closing tags */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Tags whose `name` attribute carries element-specific semantics (e.g. icon
 * identifier) rather than a navigation label. Must match the set in ui-system.js.
 */
const SKIP_NAME_ATTR_TAGS = new Set(['sl-icon', 'sl-icon-button'])

/**
 * Convert kebab-case to camelCase.
 * @param {string} s
 * @returns {string}
 */
function kebabToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

/**
 * Return the JSDoc type expression for a tag name.
 * Shoelace types are referenced via import('../ui.js').
 * @param {string} tag
 * @returns {string}
 */
function typeExpr(tag) {
  const t = TAG_TYPE_MAP[tag]
  if (!t) return 'HTMLElement'
  return t.startsWith('Sl') ? `import('../ui.js').${t}` : t
}

/**
 * @typedef {{ tag: string, name: string|null, children: TreeNode[] }} TreeNode
 */

/**
 * Parse an HTML string into a lightweight tree of nodes.
 * Only element nodes are represented; text content is ignored.
 * @param {string} html
 * @returns {TreeNode} Virtual root (tag='', name=null)
 */
function parseTree(html) {
  /** @type {TreeNode} */
  const root = { tag: '', name: null, children: [] }
  /** @type {TreeNode[]} */
  const stack = [root]

  // Match open/close/self-closing tags; skip HTML comments and DOCTYPE declarations.
  const re = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g
  for (const m of html.matchAll(re)) {
    if (!m[2]) continue // comment or doctype — skip
    const isClose = Boolean(m[1])
    const tag = m[2].toLowerCase()
    const attrs = m[3] || ''
    const isSelfClose = /\/$/.test(attrs.trimEnd()) || VOID_ELEMENTS.has(tag)

    if (isClose) {
      // Pop the stack to the matching open tag
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break }
      }
      continue
    }

    // Extract name/data-name attribute.
    // Skip `name` for elements that use it for icon identity (e.g. sl-icon).
    const nameMatch =
      (!SKIP_NAME_ATTR_TAGS.has(tag) && /\bname="([^"]*)"/.exec(attrs)) ||
      /\bdata-name="([^"]*)"/.exec(attrs)
    /** @type {TreeNode} */
    const node = { tag, name: nameMatch ? nameMatch[1] : null, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!isSelfClose) stack.push(node)
  }

  return root
}

/**
 * Find the direct named descendants of a node.
 * Mirrors findNamedDescendants() in ui-system.js:
 *   - Stops at named nodes (does not recurse into them)
 *   - Recurses through unnamed nodes
 * @param {TreeNode} node
 * @returns {TreeNode[]}
 */
function namedDescendants(node) {
  /** @type {TreeNode[]} */
  const result = []
  for (const child of node.children) {
    if (child.name) result.push(child)
    else result.push(...namedDescendants(child))
  }
  return result
}

/**
 * Recursively collect typedef definitions for a node and all its named descendants.
 * @param {TreeNode} node
 * @param {string} typedefName - Name to use for this node's typedef
 * @param {Map<string, {propName:string, tag:string, hasChildren:boolean}[]>} typedefs
 */
function collectTypedefs(node, typedefName, typedefs) {
  const children = namedDescendants(node)
  if (children.length > 0) {
    typedefs.set(typedefName, children.map(c => ({
      propName: /** @type {string} */ (c.name),
      tag: c.tag,
      hasChildren: namedDescendants(c).length > 0,
    })))
  }
  for (const child of children) {
    collectTypedefs(
      child,
      kebabToCamel(/** @type {string} */ (child.name)) + 'Part',
      typedefs,
    )
  }
}

/**
 * Generate .types.js content for a single template file.
 * @param {string} templateName - Template base name (no .html extension)
 * @param {string} html - Template HTML content
 * @returns {string|null} File content, or null if the template has no named elements
 */
function generateTypes(templateName, html) {
  const tree = parseTree(html)
  const topElements = tree.children.filter(n => n.tag)

  if (topElements.length === 0) return null

  const typedefs = new Map()

  if (topElements.length === 1 && topElements[0].name) {
    // Single named root element: typedef is named after the element, not the template.
    // (Avoids collisions when the template filename mirrors the root element's name.)
    const root = topElements[0]
    collectTypedefs(root, kebabToCamel(root.name) + 'Part', typedefs)
  } else {
    // Multiple elements, or single unnamed root: generate a container typedef
    // named after the template. namedDescendants(tree) recurses through unnamed
    // wrappers to find all top-level named elements.
    collectTypedefs(tree, kebabToCamel(templateName) + 'Part', typedefs)
  }

  if (typedefs.size === 0) return null

  const lines = [
    `// AUTO-GENERATED from ${templateName}.html — do not edit`,
    `// Regenerate with: npm run build:ui-types`,
    ``,
  ]

  for (const [name, props] of typedefs) {
    lines.push(`/**`)
    lines.push(` * @typedef {object} ${name}`)
    for (const p of props) {
      const ref = typeExpr(p.tag)
      const type = p.hasChildren
        ? `{${ref} & ${kebabToCamel(p.propName)}Part}`
        : `{${ref}}`
      lines.push(` * @property ${type} ${p.propName}`)
    }
    lines.push(` */`)
    lines.push(``)
  }

  lines.push(`export {}`)
  lines.push(``)

  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────────

const files = readdirSync(TEMPLATES_DIR)
  .filter(f => f.endsWith('.html') && !f.endsWith('.types.js'))
  .sort()

let generated = 0
let skipped = 0
let removed = 0

for (const file of files) {
  const name = basename(file, '.html')
  const html = readFileSync(join(TEMPLATES_DIR, file), 'utf8')
  const content = generateTypes(name, html)
  const outPath = join(TEMPLATES_DIR, `${name}.types.js`)

  if (!content) {
    // Delete stale output file if the template no longer produces any types
    if (existsSync(outPath)) {
      unlinkSync(outPath)
      console.log(`  ✗ ${name}.types.js (removed — template has no named elements)`)
      removed++
    }
    skipped++
    continue
  }

  writeFileSync(outPath, content, 'utf8')
  console.log(`  ✓ ${name}.types.js`)
  generated++
}

console.log(`\n${generated} type files generated, ${skipped} templates skipped, ${removed} stale files removed.`)

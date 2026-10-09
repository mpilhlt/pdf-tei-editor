/**
 * Fixed, hand-picked field list for the teiHeader editor - see
 * docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md,
 * "Revision 2" for why this replaced an earlier generic, schema-derived
 * field tree (it corrupted real documents: flattened nested markup,
 * dropped attribute-only elements, reordered mixed content). Every field
 * here is a plain leaf bound to one fixed path under `fileDesc` - no
 * schema traversal, no depth cap, no leaf/non-leaf ambiguity to get wrong.
 */

/**
 * @typedef {Object} FieldDef
 * @property {string} key - unique id; used as the dataset.field marker on rendered inputs
 * @property {string} label
 * @property {Array<string>} path - tag names from fileDesc down to the leaf
 * @property {Object<string, string>=} attrs - fixed attribute values the leaf element must carry (e.g. idno[@type="DOI"])
 * @property {boolean} repeatable
 * @property {string} description - shown as the rendered input's help text
 */

/** @type {Array<FieldDef>} */
export const FIELD_DEFS = [
  { key: 'title', label: 'Title', path: ['titleStmt', 'title'], repeatable: false, description: 'The main title of the work.' },
  { key: 'publisher', label: 'Publisher', path: ['publicationStmt', 'publisher'], repeatable: false, description: 'The organization responsible for publishing this work.' },
  { key: 'pubDate', label: 'Publication date', path: ['publicationStmt', 'date'], repeatable: false, description: 'The date this work was published.' },
  { key: 'doi', label: 'DOI', path: ['publicationStmt', 'idno'], attrs: { type: 'DOI' }, repeatable: false, description: 'The Digital Object Identifier for this work.' },
  { key: 'author', label: 'Author(s)', path: ['sourceDesc', 'biblStruct', 'analytic', 'author', 'persName'], repeatable: true, description: 'Full name of an author of the cited source.' },
  { key: 'analyticTitle', label: 'Article/chapter title', path: ['sourceDesc', 'biblStruct', 'analytic', 'title'], repeatable: false, description: 'The title of the specific article or chapter being cited.' },
  { key: 'monogrTitle', label: 'Journal/book title', path: ['sourceDesc', 'biblStruct', 'monogr', 'title'], repeatable: false, description: 'The title of the journal or book containing the cited source.' },
  { key: 'bibl', label: 'Source citation', path: ['sourceDesc', 'bibl'], repeatable: false, description: 'A free-text bibliographic citation for the source.' }
]

const ROOT_ORDER = ['titleStmt', 'publicationStmt', 'sourceDesc']

/**
 * @typedef {Object} FieldValue
 * @property {string} text - For an editable entry, the raw text to write back
 *   as the leaf element's sole text content. For a `readonly` entry, a
 *   display-only rendering of its existing nested markup (whitespace
 *   collapsed to single spaces) - never written back.
 * @property {boolean} [readonly] - True when the source leaf element had
 *   child elements (structured markup, e.g. `<persName><forename/><surname/></persName>`)
 *   when the dialog opened. Flattening such an element's text content back
 *   onto it would silently destroy that markup, so these entries must be
 *   rendered non-editable and must never have their text content rewritten.
 * @property {Element} [element] - For a `readonly` entry, its original
 *   source leaf element - used only to recognize, at save time, whether the
 *   user removed that entry's row (then its whole repeat unit is deleted);
 *   never used to write a new text content onto it.
 */

/**
 * Collapse all whitespace (including the newlines/indentation between
 * child elements of a pretty-printed document) to single spaces, for
 * displaying a structured element's text content as one flat string.
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Every element reachable from `root` by following `def.path`'s tag names
 * one level at a time, checking `def.attrs` only against the final
 * segment. Returns an empty array if any segment along the way has no
 * matching child.
 * @param {Element} root
 * @param {FieldDef} def
 * @returns {Array<Element>}
 */
function findElementsAtPath(root, def) {
  let current = [root]
  for (let i = 0; i < def.path.length; i++) {
    const tag = def.path[i]
    const isLast = i === def.path.length - 1
    /** @type {Array<Element>} */
    const next = []
    for (const parent of current) {
      for (const child of parent.children) {
        if (child.localName !== tag) continue
        if (isLast && def.attrs && !Object.entries(def.attrs).every(([name, val]) => child.getAttribute(name) === val)) continue
        next.push(child)
      }
    }
    current = next
    if (current.length === 0) return []
  }
  return current
}

/**
 * Read every field in `FIELD_DEFS` directly out of `fileDesc`, by walking
 * each field's own fixed path. A repeatable field gets one entry per
 * matching element found; a non-repeatable field gets at most its first
 * match (there is normally only one, since each path is specific). A
 * matched element that has child elements of its own (structured markup)
 * is read as a `readonly` entry (see {@link FieldValue}) instead of a
 * plain editable one.
 * @param {Element|null} fileDesc
 * @returns {Object<string, Array<FieldValue>>} keyed by `FieldDef.key`
 */
export function readFieldValues(fileDesc) {
  /** @type {Object<string, Array<FieldValue>>} */
  const values = {}
  for (const def of FIELD_DEFS) {
    const elements = fileDesc ? findElementsAtPath(fileDesc, def) : []
    values[def.key] = (def.repeatable ? elements : elements.slice(0, 1)).map((el) => {
      if (el.children.length > 0) return { text: collapseWhitespace(el.textContent ?? ''), readonly: true, element: el }
      return { text: (el.textContent ?? '').trim() }
    })
  }
  return values
}

/**
 * @param {Array<FieldValue>} a
 * @param {Array<FieldValue>} b
 * @returns {boolean}
 */
function sameValues(a, b) {
  if (a.length !== b.length) return false
  return a.every((v, i) => v.text === b[i].text)
}

/**
 * Number of path segments, counting back from the leaf, that make up one
 * "repeat unit" for a repeatable field and must therefore always be
 * created/removed together as a whole - e.g. `author`'s path ends in
 * `.../author/persName`: the repeat unit is the `author` wrapper plus its
 * `persName` child (2 segments), since each repeated author needs its own
 * wrapper element, not a second `persName` stuffed into the first
 * author's wrapper. A non-repeatable field's repeat unit is just the leaf
 * itself (1 segment).
 * @param {FieldDef} def
 * @returns {number}
 */
function repeatUnitLength(def) {
  return def.repeatable ? 2 : 1
}

/**
 * Create one new element at `def`'s path under `fileDesc`, reusing
 * existing ancestor segments where they already exist. For a repeatable
 * field, the last two path segments (the repeat unit - e.g. `author` and
 * its `persName`) are always created fresh, never reused, so adding a
 * second author never collapses into the first one's wrapper; for a
 * non-repeatable field, only the leaf itself (the last segment) is always
 * fresh. `fileDesc`'s own direct children (titleStmt/publicationStmt/
 * sourceDesc) are the one ordering constraint this dialog has to honor -
 * TEI requires that specific order among them; nothing deeper has an
 * equivalent constraint this feature needs to enforce.
 * @param {Element} fileDesc
 * @param {FieldDef} def
 * @param {string} namespaceUri
 * @returns {Element}
 */
function createElementAtPath(fileDesc, def, namespaceUri) {
  const freshFromIndex = def.path.length - repeatUnitLength(def)
  let parent = fileDesc
  for (let i = 0; i < def.path.length; i++) {
    const tag = def.path[i]
    const isLast = i === def.path.length - 1
    const mustCreateFresh = i >= freshFromIndex
    let child = mustCreateFresh ? undefined : [...parent.children].find((el) => el.localName === tag)
    if (!child) {
      child = parent.ownerDocument.createElementNS(namespaceUri, tag)
      if (isLast && def.attrs) for (const [name, val] of Object.entries(def.attrs)) child.setAttribute(name, val)
      if (parent === fileDesc && ROOT_ORDER.includes(tag)) {
        const laterTags = ROOT_ORDER.slice(ROOT_ORDER.indexOf(tag) + 1)
        const insertBefore = [...fileDesc.children].find((el) => laterTags.includes(el.localName))
        fileDesc.insertBefore(child, insertBefore ?? null)
      } else {
        parent.appendChild(child)
      }
    }
    parent = child
  }
  return parent
}

/**
 * Apply one field's change. Existing elements are split into `readonly`
 * (structured markup, e.g. `persName` with `forename`/`surname` children)
 * and plain editable ones, handled separately:
 *
 * - Readonly entries are NEVER updated - their text content is never
 *   rewritten, since it's a flattened display string, not the real markup.
 *   One is removed only if the user's corresponding row (identified by the
 *   original `element` reference carried on its {@link FieldValue}) is gone
 *   from `newValues` - i.e. the user deleted it.
 * - Editable entries keep the original positional diff: update existing
 *   elements in place (there is no drag-reorder in the UI, so "row N"
 *   identity is positional), remove any surplus, and create fresh elements
 *   for any extra new values. An existing element that's simply being
 *   updated is NEVER removed and recreated - this is what keeps an edited
 *   field's DOM position (and its siblings' position) stable.
 *
 * `findElementsAtPath()` (and therefore `existing` below) always resolves
 * to the field's LEAF elements (e.g. `persName`, not `author`). For a
 * repeatable field that matters when removing an entry: the leaf is
 * wrapped in its own repeat-unit ancestor (`author`), and removing only the
 * leaf would leave a dangling, empty `<author/>` behind rather than
 * actually deleting the repeated entry. So a removal climbs up to the
 * repeat unit's root (via `repeatUnitLength()`) before removing - for a
 * non-repeatable field that root IS the leaf, so this is a no-op climb and
 * behaves exactly as before.
 * @param {Element} fileDesc
 * @param {FieldDef} def
 * @param {Array<FieldValue>} newValues
 * @param {string} namespaceUri
 */
function applyOneField(fileDesc, def, newValues, namespaceUri) {
  const existing = findElementsAtPath(fileDesc, def)
  const existingReadonly = existing.filter((el) => el.children.length > 0)
  const existingEditable = existing.filter((el) => el.children.length === 0)
  const climbLevels = repeatUnitLength(def) - 1

  const keptElements = new Set(newValues.filter((v) => v.readonly).map((v) => v.element))
  for (const el of existingReadonly) {
    if (keptElements.has(el)) continue
    let node = el
    for (let level = 0; level < climbLevels; level++) node = node.parentElement
    node.remove()
  }

  const wanted = newValues.filter((v) => !v.readonly && v.text.trim() !== '')

  const updateCount = Math.min(existingEditable.length, wanted.length)
  for (let i = 0; i < updateCount; i++) existingEditable[i].textContent = wanted[i].text

  for (let i = wanted.length; i < existingEditable.length; i++) {
    let el = existingEditable[i]
    for (let level = 0; level < climbLevels; level++) el = el.parentElement
    el.remove()
  }

  for (let i = existingEditable.length; i < wanted.length; i++) {
    const el = createElementAtPath(fileDesc, def, namespaceUri)
    el.textContent = wanted[i].text
  }
}

/**
 * Diff `openedValues` (what the dialog opened with, from
 * `readFieldValues()`) against `currentValues` (what's in the form now)
 * and apply ONLY the fields that actually changed, mutating `fileDesc` in
 * place. A field whose value is unchanged is never touched at all - the
 * original element (if any), and everything around it, survives exactly
 * as it was. This is the fix for the data-integrity problems the previous
 * generic, rebuild-everything-on-every-save approach had (see this
 * module's header comment).
 * @param {Element} fileDesc
 * @param {Object<string, Array<FieldValue>>} openedValues
 * @param {Object<string, Array<FieldValue>>} currentValues
 * @param {string} namespaceUri
 */
export function applyFieldValues(fileDesc, openedValues, currentValues, namespaceUri) {
  for (const def of FIELD_DEFS) {
    const before = openedValues[def.key] ?? []
    const after = currentValues[def.key] ?? []
    if (sameValues(before, after)) continue
    applyOneField(fileDesc, def, after, namespaceUri)
  }
}

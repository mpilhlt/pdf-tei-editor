# TEI Header Editor — Fixed Field List Rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic, schema-derived, depth-capped recursive field tree (which corrupts real documents — see "Revision 2" in the design spec) with a small, fixed, hand-picked list of 8 metadata fields and a diff-based save that only ever touches fields the user actually changed.

**Architecture:** `app/src/modules/tei-header-form.js` is rewritten around a `FIELD_DEFS` array (each entry: a label, a fixed path of tag names from `fileDesc`, optional fixed attributes, repeatable flag). `readFieldValues(fileDesc)` walks each field's own path directly — no schema, no recursion, no depth cap. `applyFieldValues(fileDesc, openedValues, currentValues, namespaceUri)` diffs each field against its opened snapshot and only mutates fields that changed, updating existing elements in place rather than removing and recreating them. `app/src/plugins/tei-header-editor.js`'s rendering/save logic is simplified to match — one flat list of input rows, no recursive sections, no backend call, no required-field blocking.

**Spec:** [docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md](../specs/2026-10-07-teiheader-editor-plugin-design.md), "Revision 2" section.

**Context for whoever executes this:** this replaces code from an already-completed, already-reviewed 11-task plan ([2026-10-07-teiheader-editor-plugin.md](./2026-10-07-teiheader-editor-plugin.md)) that turned out, on holistic end-to-end review against the real schema, to have a fundamental data-integrity problem. Read "Revision 2" in the design spec before starting — it explains exactly what broke and why. The toolbar button, dialog template, role gating, and `install`/`start`/`onStateUpdate` in the plugin are unaffected and stay as they are.

---

### Task 1: Rewrite `tei-header-form.js` around the fixed field list

**Files:**
- Modify: `app/src/modules/tei-header-form.js` (full rewrite of its exported surface — `buildFieldTree`, `getMainInput`, the `FieldNode`/`NestedFieldValues` typedefs, and the old `readFieldValues`/`applyFieldValues`/`leavesHaveValues` are all removed)
- Modify: `tests/unit/js/tei-header-form.test.js` (full rewrite — every test in this file today exercises the removed generic-tree machinery)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/unit/js/tei-header-form.test.js` with:

```js
#!/usr/bin/env node

/**
 * @testCovers app/src/modules/tei-header-form.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { FIELD_DEFS, readFieldValues, applyFieldValues } from '../../../app/src/modules/tei-header-form.js';

const NS = 'http://www.tei-c.org/ns/1.0';

/**
 * @param {string} fileDescInnerXml
 * @returns {Element} the parsed <fileDesc> element
 */
function parseFileDesc(fileDescInnerXml) {
  const dom = new JSDOM(
    `<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc>${fileDescInnerXml}</fileDesc></teiHeader></TEI>`,
    { contentType: 'text/xml' }
  );
  return dom.window.document.getElementsByTagName('fileDesc')[0];
}

const FULL_FIXTURE = `
  <titleStmt><title>Existing Title</title></titleStmt>
  <publicationStmt>
    <publisher>Nomos Verlag</publisher>
    <date type="publication">2020</date>
    <idno type="DOI">10.1/existing</idno>
  </publicationStmt>
  <sourceDesc>
    <bibl>Existing citation text.</bibl>
    <biblStruct>
      <analytic>
        <title>Article Title</title>
        <author><persName>First Author</persName></author>
        <author><persName>Second Author</persName></author>
      </analytic>
      <monogr>
        <title>Journal Title</title>
      </monogr>
    </biblStruct>
  </sourceDesc>
`;

describe('readFieldValues', () => {
  it('reads every field at its fixed path from a fully-populated fileDesc', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const values = readFieldValues(fileDesc);
    assert.strictEqual(values.title[0].text, 'Existing Title');
    assert.strictEqual(values.publisher[0].text, 'Nomos Verlag');
    assert.strictEqual(values.pubDate[0].text, '2020');
    assert.strictEqual(values.doi[0].text, '10.1/existing');
    assert.strictEqual(values.bibl[0].text, 'Existing citation text.');
    assert.strictEqual(values.analyticTitle[0].text, 'Article Title');
    assert.strictEqual(values.monogrTitle[0].text, 'Journal Title');
    assert.deepStrictEqual(values.author.map((v) => v.text), ['First Author', 'Second Author']);
  });

  it('returns empty arrays for every field when fileDesc is empty or null', () => {
    const fileDesc = parseFileDesc('');
    const values = readFieldValues(fileDesc);
    for (const def of FIELD_DEFS) assert.deepStrictEqual(values[def.key], []);
    const valuesFromNull = readFieldValues(null);
    for (const def of FIELD_DEFS) assert.deepStrictEqual(valuesFromNull[def.key], []);
  });

  it('matches idno[@type="DOI"] specifically, not an idno with a different type', () => {
    const fileDesc = parseFileDesc('<publicationStmt><idno type="ISSN">1234-5678</idno></publicationStmt>');
    const values = readFieldValues(fileDesc);
    assert.deepStrictEqual(values.doi, []);
  });
});

describe('applyFieldValues', () => {
  it('REGRESSION: leaves every field byte-identical when nothing changed, including nested biblStruct markup', () => {
    // This is the exact failure mode the fixed-field-list rewrite exists to
    // prevent: the old generic tree flattened biblStruct/analytic's real
    // <title>/<author><persName> markup into plain concatenated text on
    // every save, even when the user touched nothing. Round-tripping
    // unmodified values must leave the whole subtree untouched.
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const before = fileDesc.cloneNode(true);
    const opened = readFieldValues(fileDesc);
    applyFieldValues(fileDesc, opened, opened, NS);
    assert.strictEqual(fileDesc.outerHTML, before.outerHTML, 'fileDesc must be byte-identical when no field changed');
  });

  it('updates an existing leaf in place without touching its siblings or position', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.publisher = [{ text: 'New Publisher' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const pubStmt = fileDesc.getElementsByTagName('publicationStmt')[0];
    assert.strictEqual(pubStmt.getElementsByTagName('publisher')[0].textContent, 'New Publisher');
    // Siblings and their order survive untouched.
    assert.strictEqual(pubStmt.children[1].localName, 'date');
    assert.strictEqual(pubStmt.children[1].textContent, '2020');
    assert.strictEqual(pubStmt.children[2].localName, 'idno');
  });

  it('creates a missing field (and its missing ancestors) only when a new, non-empty value is given', () => {
    const fileDesc = parseFileDesc('<titleStmt><title>T</title></titleStmt>');
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.monogrTitle = [{ text: 'New Journal' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const sourceDesc = fileDesc.getElementsByTagName('sourceDesc')[0];
    assert.ok(sourceDesc, 'sourceDesc must be created');
    const biblStruct = sourceDesc.getElementsByTagName('biblStruct')[0];
    assert.ok(biblStruct, 'biblStruct must be created');
    const monogr = biblStruct.getElementsByTagName('monogr')[0];
    assert.strictEqual(monogr.getElementsByTagName('title')[0].textContent, 'New Journal');
    // Unrelated fields (title) survive untouched.
    assert.strictEqual(fileDesc.getElementsByTagName('titleStmt')[0].getElementsByTagName('title')[0].textContent, 'T');
  });

  it('creates a missing root section (publicationStmt) before an already-existing later root (sourceDesc), per TEI ordering', () => {
    const fileDesc = parseFileDesc('<titleStmt><title>T</title></titleStmt><sourceDesc><bibl>B</bibl></sourceDesc>');
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.publisher = [{ text: 'New Publisher' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const tags = [...fileDesc.children].map((el) => el.localName);
    assert.deepStrictEqual(tags, ['titleStmt', 'publicationStmt', 'sourceDesc']);
  });

  it('removes a field whose value was cleared, and only that element', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.doi = [{ text: '' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const pubStmt = fileDesc.getElementsByTagName('publicationStmt')[0];
    assert.strictEqual(pubStmt.getElementsByTagName('idno').length, 0);
    assert.strictEqual(pubStmt.getElementsByTagName('publisher')[0].textContent, 'Nomos Verlag');
    assert.strictEqual(pubStmt.getElementsByTagName('date')[0].textContent, '2020');
  });

  it('handles adding a second author to a document that currently has only one', () => {
    const fileDesc = parseFileDesc('<sourceDesc><biblStruct><analytic><author><persName>Only Author</persName></author></analytic></biblStruct></sourceDesc>');
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.author = [{ text: 'Only Author' }, { text: 'New Second Author' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const authors = fileDesc.getElementsByTagName('analytic')[0].getElementsByTagName('author');
    assert.strictEqual(authors.length, 2);
    assert.strictEqual(authors[0].getElementsByTagName('persName')[0].textContent, 'Only Author');
    assert.strictEqual(authors[1].getElementsByTagName('persName')[0].textContent, 'New Second Author');
  });

  it('handles removing one of two existing authors', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.author = [{ text: 'First Author' }]; // second author row removed in the UI
    applyFieldValues(fileDesc, opened, current, NS);
    const authors = fileDesc.getElementsByTagName('analytic')[0].getElementsByTagName('author');
    assert.strictEqual(authors.length, 1);
    assert.strictEqual(authors[0].getElementsByTagName('persName')[0].textContent, 'First Author');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node tests/unit-test-runner.js tests/unit/js/tei-header-form.test.js
```

Expected: FAIL — `FIELD_DEFS`/new function signatures don't exist yet (the old file still exports the generic-tree API).

- [ ] **Step 3: Replace `app/src/modules/tei-header-form.js`'s contents entirely**

```js
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
 * @property {string} text
 */

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
 * match (there is normally only one, since each path is specific).
 * @param {Element|null} fileDesc
 * @returns {Object<string, Array<FieldValue>>} keyed by `FieldDef.key`
 */
export function readFieldValues(fileDesc) {
  /** @type {Object<string, Array<FieldValue>>} */
  const values = {}
  for (const def of FIELD_DEFS) {
    const elements = fileDesc ? findElementsAtPath(fileDesc, def) : []
    values[def.key] = (def.repeatable ? elements : elements.slice(0, 1)).map((el) => ({ text: el.textContent ?? '' }))
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
  const freshFromIndex = def.repeatable ? def.path.length - 2 : def.path.length - 1
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
 * Apply one field's change: update existing elements in place (positional
 * matching between the existing elements and the new values - there is no
 * drag-reorder in the UI, so "row N" identity is positional), remove any
 * surplus existing elements, and create fresh elements for any extra new
 * values. Existing elements that are simply being updated are NEVER
 * removed and recreated - this is what keeps an edited field's DOM
 * position (and its siblings' position) stable.
 * @param {Element} fileDesc
 * @param {FieldDef} def
 * @param {Array<FieldValue>} newValues
 * @param {string} namespaceUri
 */
function applyOneField(fileDesc, def, newValues, namespaceUri) {
  const existing = findElementsAtPath(fileDesc, def)
  const wanted = newValues.filter((v) => v.text.trim() !== '')

  const updateCount = Math.min(existing.length, wanted.length)
  for (let i = 0; i < updateCount; i++) existing[i].textContent = wanted[i].text

  for (let i = wanted.length; i < existing.length; i++) existing[i].remove()

  for (let i = existing.length; i < wanted.length; i++) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node tests/unit-test-runner.js tests/unit/js/tei-header-form.test.js
```

Expected: PASS, all tests including the regression test.

- [ ] **Step 5: Run the full JS unit suite to check for any other file importing the now-removed exports**

```bash
node tests/unit-test-runner.js
```

Expected: this will almost certainly FAIL right now, because `app/src/plugins/tei-header-editor.js` (Task 2's job, not yet done) still imports `buildFieldTree`/`leavesHaveValues`/`getMainInput`/`FieldNode`/`FieldValue` from this module. That failure is expected and will be fixed by Task 2 — do not attempt to fix `tei-header-editor.js` as part of this task; just confirm the ONLY failures are in that one file's own tests (there are none directly, but the plugin file itself won't even parse/import correctly - check with `node --check app/src/plugins/tei-header-editor.js`, which SHOULD fail with an import error, confirming the boundary is exactly where expected) and that `tests/unit/js/tei-header-form.test.js` itself is fully green in isolation (already confirmed in Step 4).

- [ ] **Step 6: Commit**

```bash
git add app/src/modules/tei-header-form.js tests/unit/js/tei-header-form.test.js
git commit -m "$(cat <<'EOF'
Rewrite tei-header-form.js around a fixed, hand-picked field list

Replaces the generic, schema-derived, depth-capped recursive field
tree (buildFieldTree/readFieldValues/applyFieldValues/
leavesHaveValues/getMainInput) with FIELD_DEFS - 8 fixed field paths
- and a diff-based readFieldValues()/applyFieldValues() pair that
only ever touches a field whose value actually changed, updating
existing elements in place rather than rebuilding whole subtrees.
See docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md's
"Revision 2" for the data-integrity problems this replaces.

This intentionally breaks app/src/plugins/tei-header-editor.js's
imports - fixed in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rewrite `tei-header-editor.js`'s rendering/save to match

**Files:**
- Modify: `app/src/plugins/tei-header-editor.js`

- [ ] **Step 1: Read the current file first**

Read `app/src/plugins/tei-header-editor.js` as it exists right now (before your changes) to confirm the exact current `install()`/`start()`/`onStateUpdate()` methods, constructor, and imports — these are UNCHANGED by this task; only `#onOpen`, `#renderSections`/`#renderSection`/`#renderLeafGroup`/`#renderLeafRow`, `#collectValuesFromForm`, `#findEmptyRequiredInputs`, and `#onSave` are replaced, along with the import line and the `#fieldTree` field.

- [ ] **Step 2: Replace the import line and remove the now-unused `client` dependency**

The current constructor declares `deps: ['xmleditor', 'client', 'logger']` and a `get #client()` getter, used only to call the now-removed backend-driven structure fetch. Since the new fixed field list needs no backend call, remove `'client'` from `deps` and delete the `get #client()` getter entirely — don't leave an unused dependency declared (YAGNI).

Replace this line:
```js
import { buildFieldTree, readFieldValues, applyFieldValues, leavesHaveValues, getMainInput } from '../modules/tei-header-form.js'
```
with:
```js
import { FIELD_DEFS, readFieldValues, applyFieldValues } from '../modules/tei-header-form.js'
```

Update the `@import` JSDoc block at the top: remove `FieldNode, FieldValue` (no longer exported) and instead import `FieldDef, FieldValue` from the same module for type annotations below.

- [ ] **Step 3: Replace the field declaration and all the methods from `#onOpen` through `#onSave`**

Replace `/** @type {Array<FieldNode>} */ #fieldTree = []` with:
```js
  /** @type {Object<string, Array<FieldValue>>} */
  #openedValues = {}
```

Replace everything from `async #onOpen()` through the end of `#onSave()` (i.e. `#onOpen`, `#renderSections`, `#renderSection`, `#renderLeafGroup`, `#renderLeafRow`, `#collectValuesFromForm`, `#findEmptyRequiredInputs`, `#onSave` — all of it) with:

```js
  async #onOpen() {
    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) return
    const fileDesc = xmlTree.getElementsByTagName('fileDesc')[0] ?? null
    this.#openedValues = readFieldValues(fileDesc)
    this.#renderFields(this.#openedValues)
    await this.#dialogUi.show()
  }

  /**
   * @param {Object<string, Array<FieldValue>>} values
   */
  #renderFields(values) {
    const container = this.#dialogUi.sectionsContainer
    container.innerHTML = ''
    for (const def of FIELD_DEFS) {
      container.appendChild(this.#renderField(def, values[def.key] ?? []))
    }
  }

  /**
   * @param {FieldDef} def
   * @param {Array<FieldValue>} entries
   * @returns {HTMLElement}
   */
  #renderField(def, entries) {
    const wrapper = document.createElement('div')
    wrapper.dataset.field = def.key
    wrapper.style.marginBottom = '0.75rem'
    const rowsContainer = document.createElement('div')
    const rows = entries.length > 0 ? entries : [{ text: '' }]
    for (const entry of rows) rowsContainer.appendChild(this.#renderFieldRow(def, entry))
    wrapper.appendChild(rowsContainer)
    if (def.repeatable) {
      const addBtn = document.createElement('sl-button')
      addBtn.textContent = `Add ${def.label}`
      addBtn.size = 'small'
      addBtn.addEventListener('click', () => rowsContainer.appendChild(this.#renderFieldRow(def, { text: '' })))
      wrapper.appendChild(addBtn)
    }
    return wrapper
  }

  /**
   * @param {FieldDef} def
   * @param {FieldValue} entry
   * @returns {HTMLElement}
   */
  #renderFieldRow(def, entry) {
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.gap = '0.5rem'
    row.style.marginBottom = '0.25rem'
    row.style.alignItems = 'flex-start'

    const isProse = def.key === 'bibl'
    const input = document.createElement(isProse ? 'sl-textarea' : 'sl-input')
    input.dataset.field = def.key
    input.size = 'small'
    input.setAttribute('label', def.label)
    input.setAttribute('help-text', def.description)
    input.value = entry.text
    input.style.flex = '1'
    row.appendChild(input)

    if (def.repeatable) {
      const removeBtn = document.createElement('sl-button')
      removeBtn.textContent = '✕'
      removeBtn.size = 'small'
      removeBtn.addEventListener('click', () => row.remove())
      row.appendChild(removeBtn)
    }
    return row
  }

  /**
   * @returns {Object<string, Array<FieldValue>>}
   */
  #collectValuesFromForm() {
    const container = this.#dialogUi.sectionsContainer
    /** @type {Object<string, Array<FieldValue>>} */
    const values = {}
    for (const def of FIELD_DEFS) {
      const wrapper = [...container.children].find((el) => el.dataset.field === def.key)
      const inputs = [...wrapper.querySelectorAll('sl-input, sl-textarea')]
      values[def.key] = inputs.map((input) => ({ text: input.value ?? '' }))
    }
    return values
  }

  async #onSave() {
    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) return
    const fileDesc = xmlTree.getElementsByTagName('fileDesc')[0]
    if (!fileDesc) return // fileDesc itself is always expected to exist already; not created by this dialog
    const currentValues = this.#collectValuesFromForm()
    applyFieldValues(fileDesc, this.#openedValues, currentValues, fileDesc.namespaceURI)
    await this.#xmlEditorApi.updateEditorFromNode(fileDesc)
    await this.#xmlEditorApi.saveIfDirty()
    this.#dialogUi.hide()
  }
```

Note what's gone and why: no more required-field validation/blocking (`#findEmptyRequiredInputs`, the `notify('Fill in all required fields...')` path) — the fixed field list has no schema-derived cardinality concept anymore, and forcing a required field was exactly what drove users to type junk into `biblStruct/monogr` in the old design. No more attribute-input rendering (`sl-select`/per-attribute `sl-input`) — the only field with a fixed attribute (DOI's `type="DOI"`) sets it automatically in `createElementAtPath()`, never exposed as separate UI. No more `getMainInput()` call — every rendered row has exactly one input now, no attribute inputs to disambiguate from.

Also remove the `notify` import if it's no longer used anywhere else in this file (check — if it was only used by the removed required-field-validation path, remove the import too; don't leave an unused import).

- [ ] **Step 4: Verify**

```bash
node --check app/src/plugins/tei-header-editor.js
node tests/unit-test-runner.js
```

Expected: `node --check` passes with no output; full JS unit suite passes (this is also the first point where Task 1's "expected failure" from its own Step 5 should now be resolved).

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/tei-header-editor.js
git commit -m "$(cat <<'EOF'
Simplify TeiHeaderEditorPlugin to render the fixed field list

Replaces the recursive section/leaf renderer and the backend-driven
structure fetch with a flat list of inputs, one per FIELD_DEFS entry.
Drops required-field blocking and per-attribute inputs - neither
applies to a fixed 8-field list. Removes the now-unused 'client'
dependency.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rewrite the E2E test for the new, simpler behavior

**Files:**
- Modify: `tests/e2e/tests/tei-header-editor.spec.js`

- [ ] **Step 1: Read the current file first**

Read `tests/e2e/tests/tei-header-editor.spec.js` as it currently exists to reuse its login/fixture-loading helpers (`navigateAndLogin`, `selectFirstDocuments`, `releaseAllLocks`, `performLogout`, the console-capture/error-monitoring setup, `ALLOWED_ERROR_PATTERNS`) and its pure-annotator role-gate test (that second test needs no changes at all — keep it as-is). Only the first test and the helper functions above it (`markDetailsByTag`, `openHeaderEditorAndExpandPublisher`) need to change, since those exist specifically to navigate the OLD recursive `sl-details` structure, which no longer exists.

- [ ] **Step 2: Write the new test**

Replace the file's header comment, the two helper functions, and the first test (keep the second "pure annotator" test and all the imports/`ALLOWED_ERROR_PATTERNS` unchanged) with:

```js
/**
 * TEI Header Editor E2E tests
 *
 * Covers the teiHeader editor dialog's happy-path round-trip (editing
 * publicationStmt/publisher as a reviewer, saving, reloading) and the
 * pure-annotator role gate (the toolbar button is hidden entirely for
 * annotator-only users - see acl-utils.js's userIsAnnotatorOnly()).
 *
 * The dialog renders a fixed list of plain fields (see FIELD_DEFS in
 * app/src/modules/tei-header-form.js) rather than a schema-derived
 * recursive tree - see docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md's
 * "Revision 2" for why. This test also asserts the save is diff-based:
 * editing one field must leave an untouched nested structure
 * (sourceDesc/biblStruct's existing author/title markup) byte-identical,
 * which is the specific property the "Revision 2" rewrite exists to
 * guarantee.
 *
 * @testCovers app/src/plugins/tei-header-editor.js
 * @testCovers app/src/modules/tei-header-form.js
 * @testCovers app/src/modules/acl-utils.js
 */

/**
 * Opens the teiHeader editor dialog for the currently loaded document.
 * @param {import('@playwright/test').Page} page
 */
async function openHeaderEditor(page) {
  await page.click('[name="headerEditorBtn"]');
  const dialog = page.locator('sl-dialog[name="teiHeaderEditorDialog"]');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500); // Shoelace dialog animation, per tests/CLAUDE.md
}

test.describe('TEI Header Editor', () => {
  test('reviewer can edit publisher and save, leaving an untouched biblStruct intact', async ({ page }) => {
    test.setTimeout(60000);

    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      await page.waitForSelector('#codemirror-container .cm-editor');
      await page.waitForFunction(() => {
        const app = /** @type {any} */ (window).app;
        const xmlEditor = app && app.getDependency('xmleditor');
        const view = xmlEditor && xmlEditor.getView();
        return view && view.state.doc.length > 0;
      }, { timeout: 15000 });
      await page.waitForTimeout(500);

      // Snapshot the fixture's existing biblStruct markup (expected to
      // have real nested <analytic>/<author><persName> structure) before
      // touching anything, so we can assert it survives untouched below.
      const biblStructBefore = await page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        const xmlTree = app.getDependency('xmleditor').getXmlTree();
        const biblStruct = xmlTree.getElementsByTagName('biblStruct')[0];
        return biblStruct ? biblStruct.outerHTML : null;
      });
      expect(biblStructBefore, 'fixture must have a biblStruct to make this test meaningful').not.toBeNull();

      await openHeaderEditor(page);

      const publisherInput = page.locator('sl-input[data-field="publisher"]');
      await expect(publisherInput).toBeVisible();
      await publisherInput.locator('input').fill('Test Publisher E2E');

      const dialog = page.locator('sl-dialog[name="teiHeaderEditorDialog"]');
      await dialog.locator('sl-button[name="saveBtn"]').click();
      await expect(dialog).not.toBeVisible({ timeout: 10000 });

      await page.reload();
      await page.waitForSelector('#codemirror-container .cm-editor');
      await page.waitForFunction(() => {
        const app = /** @type {any} */ (window).app;
        const xmlEditor = app && app.getDependency('xmleditor');
        const view = xmlEditor && xmlEditor.getView();
        return view && view.state.doc.length > 0;
      }, { timeout: 15000 });
      await page.waitForTimeout(500);

      // The edited field persisted...
      await openHeaderEditor(page);
      await expect(page.locator('sl-input[data-field="publisher"] input')).toHaveValue('Test Publisher E2E');

      // ...and the untouched biblStruct is byte-identical to before.
      const biblStructAfter = await page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        const xmlTree = app.getDependency('xmleditor').getXmlTree();
        const biblStruct = xmlTree.getElementsByTagName('biblStruct')[0];
        return biblStruct ? biblStruct.outerHTML : null;
      });
      expect(biblStructAfter).toBe(biblStructBefore);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });

  test('pure annotator does not see the header-editor button', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      await page.waitForTimeout(1000);

      await expect(page.locator('[name="headerEditorBtn"]')).toBeHidden();
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
```

(Keep the file's existing top `import`/`ALLOWED_ERROR_PATTERNS` block exactly as it is today — only the header comment, the two helper functions, and the first test body are being replaced, per Step 1's instruction. If the fixture document's `biblStruct` doesn't actually have the nested author/title structure this test assumes, adjust the "must be meaningful" assertion/comment to describe what's actually there, but keep the core property under test: an untouched part of the document must be byte-identical after an unrelated field is edited and saved.)

- [ ] **Step 3: Run the test**

```bash
node tests/e2e-runner.js tests/e2e/tests/tei-header-editor.spec.js
```

Expected: PASS, both tests. Debug for real if it fails (per `docs/code-assistant/testing-guide.md`) rather than weakening the byte-identical assertion.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/tests/tei-header-editor.spec.js
git commit -m "$(cat <<'EOF'
Rewrite teiHeader editor E2E test for the fixed field list

Replaces the sl-details navigation helpers (no longer applicable -
the dialog is now a flat list of fields) with a direct test of the
property the field-list rewrite exists to guarantee: editing one
field and saving leaves an untouched nested biblStruct byte-identical.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full regression + fix the stale "all of titleStmt" doc line

**Files:**
- Modify: `docs/development/tei-header-integrations.md`

- [ ] **Step 1: Fix the titleStmt doc line**

An earlier commit on this branch (before the field-list rewrite was decided) updated this file to say `TeiHeaderEditorPlugin` covers "all of titleStmt except respStmt". That's no longer true — per the new `FIELD_DEFS`, it only covers `titleStmt/title`. Find that line (search for `TeiHeaderEditorPlugin` in `docs/development/tei-header-integrations.md`) and change it back to describe title-only coverage, e.g. "`TeiHeaderEditorPlugin` (title only)" in the table, and update the matching prose sentence in the `## fileDesc/titleStmt` section to say it reads/writes `titleStmt/title` specifically, not all of titleStmt. Also check the `## fileDesc/publicationStmt and fileDesc/sourceDesc` section's bullet about this plugin — update it to name the actual fixed fields now covered (publisher, date, idno[DOI], bibl, biblStruct/analytic/author+title, biblStruct/monogr/title) instead of the old generic "publicationStmt/\*, sourceDesc/\* (including structured biblStruct)" description, and remove the two "known limitation" sentences about non-leaf-text-holding elements and depth-capping — neither applies anymore, since every field is now a fixed plain-text leaf with no schema-derived depth/leaf ambiguity at all.

- [ ] **Step 2: Run the full test suite**

```bash
npm run test:unit
npm run test:e2e
```

Expected: all PASS, modulo the one known pre-existing unrelated failure (`test_uses_cached_script_when_source_missing` in `tests/unit/fastapi/test_plugin_tools_sandbox_client.py`).

- [ ] **Step 3: Commit**

```bash
git add docs/development/tei-header-integrations.md
git commit -m "$(cat <<'EOF'
Fix stale titleStmt/publicationStmt doc lines after field-list rewrite

The field-list rewrite narrowed TeiHeaderEditorPlugin's actual scope
back to a fixed set of leaf fields (titleStmt/title specifically, not
all of titleStmt as an earlier commit on this branch said) - update
the integrations map to match, and drop the two "known limitation"
notes that no longer apply now that every field is a fixed plain-text
leaf.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

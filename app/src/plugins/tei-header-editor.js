/**
 * TEI Header Editor Plugin
 *
 * Adds a toolbar button to the XML editor that opens a schema-driven
 * dialog for editing fileDesc/titleStmt, fileDesc/publicationStmt, and
 * fileDesc/sourceDesc. Hidden for pure annotators (acl-utils.js's
 * userIsAnnotatorOnly()), matching the existing teiHeader-visibility
 * safeguard in tei-tools.js.
 *
 * See docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { SlDialog } from '../ui.js'
 * @import { teiHeaderEditorDialogPart } from '../templates/tei-header-editor-dialog.types.js'
 * @import { FieldNode, FieldValue } from '../modules/tei-header-form.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'
import { userIsAnnotatorOnly } from '../modules/acl-utils.js'
import { buildFieldTree, readFieldValues, applyFieldValues, leavesHaveValues } from '../modules/tei-header-form.js'
import { notify } from '../modules/sl-utils.js'

await registerTemplate('tei-header-editor-dialog', 'tei-header-editor-dialog.html')

class TeiHeaderEditorPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tei-header-editor', deps: ['xmleditor', 'client', 'logger'] })
  }

  get #xmlEditorApi() { return this.getDependency('xmleditor') }
  get #client() { return this.getDependency('client') }

  /** @type {StatusButton} */
  #headerEditorBtn

  /** @type {SlDialog & teiHeaderEditorDialogPart} */
  #dialogUi

  /** @type {Array<FieldNode>} */
  #fieldTree = []

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.getDependency('logger').debug('Installing plugin "tei-header-editor"')

    this.#headerEditorBtn = PanelUtils.createButton({
      icon: 'card-heading',
      tooltip: 'Edit header metadata',
      name: 'headerEditorBtn'
    })
    this.#xmlEditorApi.addToolbarWidget(this.#headerEditorBtn, 1)

    this.#dialogUi = this.createUi(createSingleFromTemplate('tei-header-editor-dialog', document.body))
  }

  async start() {
    this.getDependency('logger').debug('Starting plugin "tei-header-editor"')
    this.#headerEditorBtn.addEventListener('widget-click', () => this.#onOpen())
    this.#dialogUi.cancelBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.saveBtn.addEventListener('click', () => this.#onSave())
  }

  async onStateUpdate(_changedKeys) {
    const hasDocument = !!this.state.xml
    const isAnnotatorOnly = userIsAnnotatorOnly(this.state.user)
    this.#headerEditorBtn.disabled = !hasDocument
    this.#headerEditorBtn.style.display = isAnnotatorOnly ? 'none' : ''
  }

  async #onOpen() {
    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) return
    let structure
    try {
      structure = await this.#client.apiClient.validateTeiheaderStructure({ xml_string: this.state.xml ?? '' })
    } catch (error) {
      this.getDependency('logger').warn(`tei-header-editor: could not load schema structure: ${String(error)}`)
      return
    }
    this.#fieldTree = buildFieldTree(structure)
    this.#renderSections(xmlTree)
    await this.#dialogUi.show()
  }

  /**
   * Populates {@link TeiHeaderEditorPlugin#dialogUi}'s sections container with
   * one rendered section per root field (titleStmt, publicationStmt,
   * sourceDesc), reading each root's current values out of the live
   * `fileDesc` element.
   * @param {Document} xmlTree
   */
  #renderSections(xmlTree) {
    const container = this.#dialogUi.sectionsContainer
    container.innerHTML = ''
    const fileDesc = xmlTree.getElementsByTagName('fileDesc')[0]
    for (const rootNode of this.#fieldTree) {
      const scopeNode = fileDesc ? [...fileDesc.children].find((el) => el.localName === rootNode.tag) : undefined
      const values = scopeNode ? readFieldValues(rootNode.children, scopeNode) : {}
      container.appendChild(this.#renderSection(rootNode, values))
    }
  }

  /**
   * Recursively renders `node`: a group of input rows for a leaf tag, or a
   * collapsible `sl-details` section containing the rendered children for a
   * non-leaf tag. `valueForNode` is `node`'s OWN value: an array of
   * `FieldValue` if `node.isLeaf`, otherwise a nested dict of its own
   * children's values (same shape `readFieldValues()`/`applyFieldValues()`
   * use) - never the same object re-passed unchanged to every recursive
   * call, which would collide same-named leaves under different parents
   * (e.g. `analytic`'s `title` vs `monogr`'s `title` - see
   * tei-header-form.js's nesting note).
   * @param {FieldNode} node
   * @param {Array<FieldValue>|Object<string, any>|undefined} valueForNode
   * @returns {HTMLElement}
   */
  #renderSection(node, valueForNode) {
    if (node.isLeaf) {
      node.el = this.#renderLeafGroup(node, /** @type {Array<FieldValue>} */ (valueForNode) ?? [])
      return node.el
    }
    const childrenValues = /** @type {Object<string, any>} */ (valueForNode) ?? {}
    const details = document.createElement('sl-details')
    details.summary = node.tag
    if (node.description) details.title = node.description
    for (const child of node.children) {
      details.appendChild(this.#renderSection(child, childrenValues[child.tag]))
    }
    node.el = details
    return details
  }

  /**
   * One repeatable group of input rows for a leaf tag.
   * @param {FieldNode} node
   * @param {Array<FieldValue>} entries
   * @returns {HTMLElement}
   */
  #renderLeafGroup(node, entries) {
    const group = document.createElement('div')
    group.dataset.tag = node.tag
    const rows = entries.length > 0 ? entries : [{ text: '', attrs: {} }]
    for (const entry of rows) group.appendChild(this.#renderLeafRow(node, entry))
    if (node.repeatable) {
      const addBtn = document.createElement('sl-button')
      addBtn.textContent = `Add ${node.tag}`
      addBtn.size = 'small'
      addBtn.addEventListener('click', () => group.insertBefore(this.#renderLeafRow(node, { text: '', attrs: {} }), addBtn))
      group.appendChild(addBtn)
    }
    return group
  }

  /**
   * @param {FieldNode} node
   * @param {FieldValue} entry
   * @returns {HTMLElement}
   */
  #renderLeafRow(node, entry) {
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.gap = '0.5rem'
    row.style.marginBottom = '0.25rem'

    const input = document.createElement(entry.text.includes('\n') ? 'sl-textarea' : 'sl-input')
    input.dataset.tag = node.tag
    input.size = 'small'
    input.value = entry.text
    if (node.required) input.required = true
    if (node.description) input.setAttribute('help-text', node.description)
    row.appendChild(input)

    for (const attr of node.attributes) {
      const attrInput = document.createElement(attr.values ? 'sl-select' : 'sl-input')
      attrInput.size = 'small'
      attrInput.dataset.attr = attr.name
      if (attr.values) {
        for (const v of attr.values) {
          const opt = document.createElement('sl-option')
          opt.value = v
          opt.textContent = v
          attrInput.appendChild(opt)
        }
      }
      attrInput.value = entry.attrs[attr.name] ?? ''
      row.appendChild(attrInput)
    }

    if (node.repeatable) {
      const removeBtn = document.createElement('sl-button')
      removeBtn.textContent = '✕'
      removeBtn.size = 'small'
      removeBtn.addEventListener('click', () => row.remove())
      row.appendChild(removeBtn)
    }
    return row
  }

  /**
   * Inverse of `readFieldValues()`, but reading from `node.el` (the
   * rendered markup) instead of the document DOM. Returns a dict of
   * `node`'s OWN children's values, keyed by tag - a non-leaf child's
   * entry is the same shape recursively for ITS children, never flattened
   * into this level's keys (same nesting rule as `readFieldValues()`/
   * `applyFieldValues()` - see tei-header-form.js's note on why).
   * @param {FieldNode} node
   * @returns {Object<string, any>}
   */
  #collectValuesFromForm(node) {
    /** @type {Object<string, any>} */
    const values = {}
    for (const child of node.children) {
      if (child.isLeaf) {
        const rows = [...child.el.children].filter((el) => el.tagName === 'DIV')
        values[child.tag] = rows.map((row) => {
          const input = row.querySelector('sl-input, sl-textarea')
          const attrs = {}
          for (const attrEl of row.querySelectorAll('[data-attr]')) attrs[attrEl.dataset.attr] = attrEl.value
          return { text: input?.value ?? '', attrs }
        })
      } else {
        values[child.tag] = this.#collectValuesFromForm(child)
      }
    }
    return values
  }

  /**
   * Required leaves (per the core schema's cardinality) with no non-empty
   * value anywhere in the rendered form. Returns the offending inputs so
   * the caller can focus/flag them, rather than just a boolean.
   * @param {FieldNode} node
   * @returns {Array<HTMLElement>}
   */
  #findEmptyRequiredInputs(node) {
    /** @type {Array<HTMLElement>} */
    const offenders = []
    for (const child of node.children) {
      if (child.isLeaf) {
        if (!child.required) continue
        const inputs = [...child.el.querySelectorAll('sl-input, sl-textarea')]
        if (!inputs.some((el) => el.value.trim() !== '')) offenders.push(inputs[0])
      } else {
        offenders.push(...this.#findEmptyRequiredInputs(child))
      }
    }
    return offenders
  }

  async #onSave() {
    const offenders = this.#fieldTree.flatMap((root) => this.#findEmptyRequiredInputs(root))
    if (offenders.length > 0) {
      offenders[0].invalid = true
      offenders[0].focus()
      notify('Fill in all required fields before saving.', 'warning', 'exclamation-triangle')
      return
    }

    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) return
    const fileDesc = xmlTree.getElementsByTagName('fileDesc')[0]
    if (!fileDesc) return // fileDesc itself is always expected to exist already; not created by this dialog
    const namespaceUri = fileDesc.namespaceURI
    for (const rootNode of this.#fieldTree) {
      const values = this.#collectValuesFromForm(rootNode)
      let scopeNode = [...fileDesc.children].find((el) => el.localName === rootNode.tag)
      const hasAnyValue = leavesHaveValues(rootNode.children, values)
      if (!scopeNode) {
        if (!hasAnyValue) continue
        scopeNode = xmlTree.createElementNS(namespaceUri, rootNode.tag)
        fileDesc.appendChild(scopeNode)
      }
      applyFieldValues(rootNode.children, scopeNode, values, namespaceUri)
    }
    await this.#xmlEditorApi.updateEditorFromNode(fileDesc)
    await this.#xmlEditorApi.saveIfDirty()
    this.#dialogUi.hide()
  }
}

export default TeiHeaderEditorPlugin

export const plugin = TeiHeaderEditorPlugin

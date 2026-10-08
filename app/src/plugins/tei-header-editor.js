/**
 * TEI Header Editor Plugin
 *
 * Adds a toolbar button to the XML editor that opens a dialog for editing
 * a fixed, hand-picked list of teiHeader metadata fields (see FIELD_DEFS
 * in tei-header-form.js). Hidden for pure annotators (acl-utils.js's
 * userIsAnnotatorOnly()), matching the existing teiHeader-visibility
 * safeguard in tei-tools.js.
 *
 * See docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md,
 * "Revision 2" section.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { SlDialog } from '../ui.js'
 * @import { teiHeaderEditorDialogPart } from '../templates/tei-header-editor-dialog.types.js'
 * @import { FieldDef, FieldValue } from '../modules/tei-header-form.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'
import { userIsAnnotatorOnly } from '../modules/acl-utils.js'
import { FIELD_DEFS, readFieldValues, applyFieldValues } from '../modules/tei-header-form.js'

await registerTemplate('tei-header-editor-dialog', 'tei-header-editor-dialog.html')

class TeiHeaderEditorPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tei-header-editor', deps: ['xmleditor', 'logger'] })
  }

  get #xmlEditorApi() { return this.getDependency('xmleditor') }

  /** @type {StatusButton} */
  #headerEditorBtn

  /** @type {SlDialog & teiHeaderEditorDialogPart} */
  #dialogUi

  /** @type {Object<string, Array<FieldValue>>} */
  #openedValues = {}

  /** @param {ApplicationState} state */
  async install(state) {
    console.error('DEBUG tei-header-editor: install() called')
    try {
      await super.install(state)
      this.getDependency('logger').debug('Installing plugin "tei-header-editor"')

      this.#headerEditorBtn = PanelUtils.createButton({
        icon: 'card-heading',
        tooltip: 'Edit header metadata',
        name: 'headerEditorBtn'
      })
      this.#xmlEditorApi.addToolbarWidget(this.#headerEditorBtn, 1)

      this.#dialogUi = this.createUi(createSingleFromTemplate('tei-header-editor-dialog', document.body))
      console.error('DEBUG tei-header-editor: install() succeeded, button =', this.#headerEditorBtn)
    } catch (error) {
      console.error('DEBUG tei-header-editor: install() THREW', error)
      throw error
    }
  }

  async start() {
    console.error('DEBUG tei-header-editor: start() called')
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
}

export default TeiHeaderEditorPlugin

export const plugin = TeiHeaderEditorPlugin

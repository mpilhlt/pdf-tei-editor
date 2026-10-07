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
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'
import { userIsAnnotatorOnly } from '../modules/acl-utils.js'

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
  }

  async onStateUpdate(_changedKeys) {
    const hasDocument = !!this.state.xml
    const isAnnotatorOnly = userIsAnnotatorOnly(this.state.user)
    this.#headerEditorBtn.disabled = !hasDocument
    this.#headerEditorBtn.style.display = isAnnotatorOnly ? 'none' : ''
  }

  async #onOpen() {
    // Task 9 fills this in: fetch structure, populate from the live DOM, show the dialog.
  }
}

export default TeiHeaderEditorPlugin

export const plugin = TeiHeaderEditorPlugin

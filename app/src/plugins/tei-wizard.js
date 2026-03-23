/**
 * This plugin provides a TEI Wizard to enhance the XML document.
 * It runs a series of modular enhancements defined in the /tei-wizard/enhancements/ directory.
 * TODO - this should be converted to a frontend extension of the backend TEI wizard plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton } from '../ui.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

//
// UI Parts
//

/**
 * TEI Wizard dialog navigation properties
 * @typedef {object} teiWizardDialogPart
 * @property {HTMLDivElement} enhancementList - Container for enhancement checkboxes
 * @property {SlButton} selectAll - Select all checkboxes button
 * @property {SlButton} selectNone - Select none checkboxes button
 * @property {SlButton} executeBtn - Execute wizard button
 * @property {SlButton} cancel - Cancel button
 */

import { Plugin } from '../modules/plugin-base.js'
import ui from '../ui.js'
import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import { getEnhancements } from '../modules/enhancement-registry.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'
import { api as configApi } from './config.js'
import { encodeXmlEntities, escapeXml } from '../modules/tei-utils.js'
import { api as xmlEditorApi } from './xmleditor.js'

// Register templates
await registerTemplate('tei-wizard-button', 'tei-wizard-button.html')
await registerTemplate('tei-wizard-dialog', 'tei-wizard-dialog.html')

class TeiWizardPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tei-wizard', deps: ['services', 'logger'] })
  }

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "tei-wizard"`)

    await this.#loadEnhancements()

    const teiWizardButton = createSingleFromTemplate('tei-wizard-button')
    createSingleFromTemplate('tei-wizard-dialog', document.body)

    ui.xmlEditor.toolbar.add(teiWizardButton, 51.5)
    updateUi()

    ui.xmlEditor.toolbar.teiWizardBtn.addEventListener('widget-click', () => this.#runTeiWizard())

    /** @type {teiWizardDialogPart & import('../ui.js').SlDialog} */
    const dialog = /** @type {any} */(ui.teiWizardDialog)

    this.#populateEnhancementList()

    dialog.selectAll.addEventListener('click', () => {
      const checkboxes = dialog.enhancementList.querySelectorAll('sl-checkbox')
      checkboxes.forEach(checkbox => checkbox.checked = true)
    })
    dialog.selectNone.addEventListener('click', () => {
      const checkboxes = dialog.enhancementList.querySelectorAll('sl-checkbox')
      checkboxes.forEach(checkbox => checkbox.checked = false)
    })
  }

  async onStateUpdate(_changedKeys) {
    const state = this.state
    const isAnnotator = userHasRole(state.user, ['admin', 'reviewer', 'annotator'])
    const isReviewer = userHasRole(state.user, ['admin', 'reviewer'])
    ui.xmlEditor.toolbar.teiWizardBtn.disabled = state.editorReadOnly || !isAnnotator || (isGoldFile(state.xml) && !isReviewer)
  }

  async #loadEnhancements() {
    const logger = this.getDependency('logger')
    return new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = '/api/plugins/tei-wizard/enhancements.js'
      script.onload = () => {
        logger.debug(`Loaded ${getEnhancements().length} TEI enhancements from backend`)
        resolve()
      }
      script.onerror = (err) => {
        logger.warn('Failed to load TEI enhancements from backend:', err)
        resolve()
      }
      document.head.appendChild(script)
    })
  }

  #populateEnhancementList() {
    /** @type {teiWizardDialogPart & import('../ui.js').SlDialog} */
    const dialog = /** @type {any} */(ui.teiWizardDialog)
    dialog.enhancementList.innerHTML = ''

    const enhancements = getEnhancements()
    enhancements.forEach(enhancement => {
      const escapedNameForAttr = escapeXml(enhancement.name, { encodeQuotes: true })
      const escapedNameForText = escapeXml(enhancement.name)
      const escapedDescription = escapeXml(enhancement.description, { encodeQuotes: true })
      const checkboxHtml = `
    <sl-tooltip content="${escapedDescription}" hoist placement="right">
      <sl-checkbox data-enhancement="${escapedNameForAttr}" size="medium">${escapedNameForText}</sl-checkbox>
    </sl-tooltip>
    <br />`
      dialog.enhancementList.insertAdjacentHTML('beforeend', checkboxHtml)
    })
  }

  async #getSelectedEnhancements() {
    /** @type {teiWizardDialogPart & import('../ui.js').SlDialog} */
    const dialog = /** @type {any} */(ui.teiWizardDialog)
    dialog.show()
    return new Promise((resolve) => {
      dialog.cancel.addEventListener('click', () => dialog.hide() && resolve([]))
      dialog.executeBtn.addEventListener('click', () => {
        const enhancements = getEnhancements()
        const enhancementFunctions = Array.from(dialog.enhancementList.querySelectorAll('sl-checkbox'))
          .filter(checkbox => checkbox.checked)
          .map(checkbox => enhancements.find(e => e.name === checkbox.dataset.enhancement))
        dialog.hide()
        resolve(enhancementFunctions)
      })
    })
  }

  async #runTeiWizard() {
    let teiDoc = xmlEditorApi.getXmlTree()
    if (!teiDoc) {
      console.error('TEI document not available.')
      return
    }

    const selectedEnhancements = await this.#getSelectedEnhancements()

    if (selectedEnhancements.length === 0) {
      console.log('No enhancements selected. Exiting TEI Wizard.')
      return
    }
    console.log(`Running ${selectedEnhancements.length} TEI enhancement(s)...`)

    const configMap = configApi.toMap()

    for (const enhancement of selectedEnhancements) {
      try {
        console.log(`- Applying: ${enhancement.name}`)
        const result = enhancement.execute(teiDoc, this.state, configMap)
        if (result instanceof Promise) {
          ui.spinner.show(`Applying: ${enhancement.name}`)
          teiDoc = await result
          ui.spinner.hide()
        } else {
          teiDoc = result
        }
      } catch (error) {
        ui.spinner.hide()
        console.error(`Error during enhancement "${enhancement.name}":`, error)
        notify(`Enhancement "${enhancement.name}" failed: ${error.message}`, 'danger')
        return
      }
    }

    //@ts-ignore
    let xmlstring = (new XMLSerializer()).serializeToString(teiDoc)
    xmlstring = xmlstring.replace(/(?<!<TEI[^>]*)\sxmlns=".+?"/, '')

    if (await configApi.get('xml.encode-entities.client')) {
      const encodeQuotes = await configApi.get('xml.encode-quotes', false)
      xmlstring = encodeXmlEntities(xmlstring, { encodeQuotes })
    }

    xmlEditorApi.showMergeView(xmlstring)

    notify(`${selectedEnhancements.length} TEI enhancements applied successfully.`, 'success')
  }
}

export default TeiWizardPlugin

export const plugin = TeiWizardPlugin

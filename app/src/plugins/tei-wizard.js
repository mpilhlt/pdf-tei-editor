/**
 * This plugin provides a TEI Wizard to enhance the XML document.
 * It runs a series of modular enhancements defined in the /tei-wizard/enhancements/ directory.
 * TODO - this should be converted to a frontend extension of the backend TEI wizard plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { teiWizardDialogPart } from '../templates/tei-wizard-dialog.types.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ui from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { getEnhancements } from '../modules/enhancement-registry.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'
import { encodeXmlEntities, escapeXml } from '../modules/tei-utils.js'

// Register templates
await registerTemplate('tei-wizard-button', 'tei-wizard-button.html')
await registerTemplate('tei-wizard-dialog', 'tei-wizard-dialog.html')

class TeiWizardPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tei-wizard', deps: ['services', 'logger', 'xmleditor'] })
  }

  get #configApi() { return this.getDependency('config') }
  get #xmlEditorApi() { return this.getDependency('xmleditor') }

  /** @type {SlDialog & teiWizardDialogPart} */
  #ui = null
  /** @type {StatusButton} */
  #teiWizardBtn = null

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "tei-wizard"`)

    await this.#loadEnhancements()

    this.#teiWizardBtn = createSingleFromTemplate('tei-wizard-button')
    this.#ui = this.createUi(createSingleFromTemplate('tei-wizard-dialog', document.body))

    this.#xmlEditorApi.addToolbarWidget(this.#teiWizardBtn, 51.5)

    this.#teiWizardBtn.addEventListener('widget-click', () => this.#runTeiWizard())

    this.#populateEnhancementList()

    this.#ui.selectAll.addEventListener('click', () => {
      const checkboxes = this.#ui.enhancementList.querySelectorAll('sl-checkbox')
      checkboxes.forEach(checkbox => checkbox.checked = true)
    })
    this.#ui.selectNone.addEventListener('click', () => {
      const checkboxes = this.#ui.enhancementList.querySelectorAll('sl-checkbox')
      checkboxes.forEach(checkbox => checkbox.checked = false)
    })
  }

  async onStateUpdate(_changedKeys) {
    const state = this.state
    const isAnnotator = userHasRole(state.user, ['admin', 'reviewer', 'annotator'])
    const isReviewer = userHasRole(state.user, ['admin', 'reviewer'])
    this.#teiWizardBtn.disabled = state.editorReadOnly || !isAnnotator || (isGoldFile(state.xml) && !isReviewer)
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
    this.#ui.enhancementList.innerHTML = ''

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
      this.#ui.enhancementList.insertAdjacentHTML('beforeend', checkboxHtml)
    })
  }

  async #getSelectedEnhancements() {
    this.#ui.show()
    return new Promise((resolve) => {
      this.#ui.cancel.addEventListener('click', () => { this.#ui.hide(); resolve([]) })
      this.#ui.executeBtn.addEventListener('click', () => {
        const enhancements = getEnhancements()
        const enhancementFunctions = Array.from(this.#ui.enhancementList.querySelectorAll('sl-checkbox'))
          .filter(checkbox => checkbox.checked)
          .map(checkbox => enhancements.find(e => e.name === checkbox.dataset.enhancement))
        this.#ui.hide()
        resolve(enhancementFunctions)
      })
    })
  }

  async #runTeiWizard() {
    let teiDoc = this.#xmlEditorApi.getXmlTree()
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

    const configMap = this.#configApi.toMap()

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

    if (await this.#configApi.get('xml.encode-entities.client')) {
      const encodeQuotes = await this.#configApi.get('xml.encode-quotes', false)
      xmlstring = encodeXmlEntities(xmlstring, { encodeQuotes })
    }

    this.#xmlEditorApi.showMergeView(xmlstring)

    notify(`${selectedEnhancements.length} TEI enhancements applied successfully.`, 'success')
  }
}

export default TeiWizardPlugin

export const plugin = TeiWizardPlugin

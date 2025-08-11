/**
 * The XML Editor plugin
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 */

import ui, { updateUi } from '../ui.js'
import { validation, services } from '../app.js'
import { StatusBarUtils } from '../modules/statusbar/index.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { api as logger } from './logger.js'
import { setDiagnostics } from '@codemirror/lint'

// the path to the autocompletion data
// Note: tagDataPath removed - autocomplete data now loaded dynamically per document

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const xmlEditor = new NavXmlEditor('codemirror-container')

// Status widgets for XML editor statusbar
let readOnlyStatusWidget = null
let validationStatusWidget = null
let savingStatusWidget = null

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install,
  state: {
    update
  }
}

export { xmlEditor as api, plugin, XMLEditor }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // Note: Autocomplete data is now loaded dynamically per document in services.js
  // The static tagData loading has been removed in favor of schema-specific autocomplete data

  // Create status widgets for XML editor statusbar
  readOnlyStatusWidget = StatusBarUtils.createText({
    text: '🔒 File is read-only',
    variant: 'warning'
  })
  validationStatusWidget = StatusBarUtils.createText({
    text: 'Invalid XML',
    variant: 'error'
  })
  savingStatusWidget = StatusBarUtils.createText({
    text: 'Saving XML...',
    variant: 'info'
  })

  // selection => xpath state
  xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, evt => {
    xmlEditor.whenReady().then(() => onSelectionChange(state))
  });

  // manually show diagnostics if validation is disabled
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, /** @type CustomEvent */ evt => {
    if (validation.isDisabled()) {
      let view = xmlEditor.getView()
      // @ts-ignore
      let diagnostic = evt.detail
      try {
        view.dispatch(setDiagnostics(view.state, [diagnostic]))
      } catch (error) {
        logger.warn("Error setting diagnostics: " + error.message)
      }
    }
  })
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  //console.warn("update", plugin.name, state)

  if (state.xml === null) {
    xmlEditor.clear()
    return 
  }

  if (state.editorReadOnly !== xmlEditor.isReadOnly()) {
    // update the editor read-only state
    xmlEditor.setReadOnly(state.editorReadOnly)
    logger.debug(`Setting editor read-only state to ${state.editorReadOnly}`)
    if (state.editorReadOnly) {
      ui.xmlEditor.classList.add("editor-readonly")
      if (readOnlyStatusWidget && !readOnlyStatusWidget.isConnected) {
        ui.xmlEditor.statusbar.addWidget(readOnlyStatusWidget, 'left', 5)
      }
    } else {
      ui.xmlEditor.classList.remove("editor-readonly")
      if (readOnlyStatusWidget && readOnlyStatusWidget.isConnected) {
        ui.xmlEditor.statusbar.removeWidget(readOnlyStatusWidget)
      }
    }
  }

  // xpath state => selection
  if (xmlEditor.isReady() && state.xpath && state.xml) {
    const { index, pathBeforePredicates } = parseXPath(state.xpath)
    // select the node by index
    try {
      const size = xmlEditor.countDomNodesByXpath(state.xpath)
      if (size > 0 && (index !== xmlEditor.currentIndex)) {
        xmlEditor.parentPath = pathBeforePredicates
        xmlEditor.selectByIndex(index || 1)
      }
    } catch (e) {
      console.error(e)
    }
  }
  //console.warn(plugin.name,"done")
}


/**
 * Called when the selection in the editor changes to update the cursor xpath
 * @param {ApplicationState} state
 */
async function onSelectionChange(state) {
  if (!(xmlEditor.selectedXpath && state.xpath)) {
    // this usually means that the editor is not ready yet
    //console.warn("Could not determine xpath of last selected node")
    return
  }
  // update state from the xpath of the nearest selection node

  const cursorXpath = xmlEditor.selectedXpath
  const cursorParts = parseXPath(cursorXpath)
  const stateParts = parseXPath(state.xpath)

  const normativeXpath = ui.floatingPanel.xpath.value
  const index = cursorParts.index

  // todo: use isXPathsubset()
  if (index !== null && cursorParts.tagName === stateParts.tagName && index !== xmlEditor.currentIndex + 1) {
    const xpath = `${normativeXpath}[${index}]`
    //logger.debug(xpath)
    //updateState(state, {xpath})
  }
}

/**
 * Save the current XML file if the editor is "dirty"
 */
async function saveIfDirty() {
  const filePath = String(ui.toolbar.xml.value)

  if (filePath && xmlEditor.getXmlTree() && xmlEditor.isDirty()) {
    const result = await services.saveXml(filePath)
    if (result.status == "unchanged") {
      logger.debug(`File has not changed`)
    } else {
      logger.debug(`Saved file to ${result.path}`)
    }
  }
}


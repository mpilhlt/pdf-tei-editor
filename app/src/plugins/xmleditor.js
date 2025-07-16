/**
 * The XML Editor plugin
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 */

import { invoke, updateState, validation, xmlEditor } from '../app.js'
import ui from '../ui.js'
import { NavXmlEditor, XMLEditor  } from '../modules/navigatable-xmleditor.js'
import { parseXPath, isXPathSubset } from '../modules/utils.js'
import { api as logger } from './logger.js'

// the path to the autocompletion data
const tagDataPath = '/data/tei.json'

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const api = new NavXmlEditor('codemirror-container')

// add a editor "dirty" state (this is an ad-hoc solution, to be replaced with a more robust one)
api.isDirty = false

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install,
  state: { update }
}

export { api, plugin, XMLEditor}
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  // load autocomplete data
  try {
    const res = await fetch(tagDataPath);
    const tagData = await res.json();
    api.startAutocomplete(tagData)
    logger.info("Loaded autocompletion data...");
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
  }

  // selection => xpath state
  api.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, evt => {
    api.whenReady().then(() => onSelectionChange(state))
  });

  // editor dirty state
  api.addEventListener(XMLEditor.EVENT_XML_CHANGED,evt => {
    api.isDirty = true
  })
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  // xpath state => selection
  if (!state.xpath) {
    return
  }
  await xmlEditor.whenReady()
  const { index, pathBeforePredicates } = parseXPath(state.xpath)
  // select the node by index
  try {
    const size = api.countDomNodesByXpath(state.xpath)
    if (size > 0 && (index !== api.currentIndex)) {
      api.parentPath = pathBeforePredicates
      api.selectByIndex(index || 1)
    }
  } catch (e) {
    console.error(e)
  }
}


/**
 * Called when the selection in the editor changes to update the cursor xpath
 * @param {ApplicationState} state
 */
async function onSelectionChange(state) {
  if (!(api.selectedXpath && state.xpath)) {
    // this usually means that the editor is not ready yet
    //console.warn("Could not determine xpath of last selected node")
    return
  }
  // update state from the xpath of the nearest selection node

  const cursorXpath = api.selectedXpath
  const cursorParts = parseXPath(cursorXpath)
  const stateParts = parseXPath(state.xpath)
  
  const normativeXpath = ui.floatingPanel.xpath.value
  const index = cursorParts.index

  // todo: use isXPathsubset()
  if (index !== null && cursorParts.tagName === stateParts.tagName && index !== api.currentIndex + 1) {
    const xpath = `${normativeXpath}[${index}]`
    //logger.debug(xpath)
    //updateState(state, {xpath})
  }
}

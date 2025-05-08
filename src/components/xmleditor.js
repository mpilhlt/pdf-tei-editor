import { app, PdfTeiEditor } from '../app.js'
import { NavXmlEditor, XMLEditor  } from '../modules/navigatable-xmleditor.js'
import { xpathInfo } from '../modules/utils.js'

// the path to the autocompletion data
const tagDataPath = '/data/tei.json'

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const xmlEditorComponent = new NavXmlEditor('xml-editor')
const api = xmlEditorComponent;

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install
}

export { XMLEditor, api, plugin}
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent('xmleditor', xmlEditorComponent, 'xmleditor')
  app.logger.info("XML Editor component installed.")

  // load autocomplete data
  try {
    const res = await fetch(tagDataPath);
    const tagData = await res.json();
    api.startAutocomplete(tagData)
    app.logger.info("Loaded autocompletion data...");
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
  }
 
  // xpath state => selection
  app.on("change:xpath", (value, old) => {
    api.whenReady().then(() => onXpathChange(value, old))
  })

  // selection => xpath state
  api.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, evt => {
    api.whenReady().then(() => onSelectionChange(evt))
  });
}



/**
 * Called when the app state "xpath" changes to update the selection
 * @param {string|null} xpath The new xpath for selection
 * @param {string|null} old The previous xpath
 * @returns {void}
 */
function onXpathChange(xpath, old) {
  if (!xpath) {
    return
  }
  const { index, beforeIndex } = xpathInfo(xpath)
  // select the first node
  try {
    const size = xmlEditorComponent.countDomNodesByXpath(xpath)
    if (size > 0 && (index !== api.currentIndex)) {
      api.parentPath = beforeIndex
      api.selectByIndex(index || 1)
    }
  } catch (e) {
    console.error(e)
  }
}

/**
 * Called when the selection in the editor changes to update the cursor xpath
 */
async function onSelectionChange() {
  const xpath = api.selectedXpath
  if (!xpath)  {
    // this usually means that the editor is not ready yet
    //console.warn("Could not determine xpath of last selected node")
    return
  }
  // update state from the xpath of the nearest selection node
  const { basename } = xpathInfo(xpath)
  app.xpath = `//tei:${basename}` // the xpath from the DOM does not have a prefix, todo unhardcode
}
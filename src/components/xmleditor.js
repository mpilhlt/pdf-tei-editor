import { XMLEditor } from '../modules/xmleditor.js'
import { App } from '../modules/app.js'

/**
 * component is an instance of XMLEditor
 * @type {XMLEditor}
 */
export const xmlEditorComponent = new XMLEditor('xml-editor')

// the path oto the autocompletion data
const tagDataPath = '/data/tei.json'

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {App} app The main application
 */
async function start(app) {
  app.registerComponent('xmleditor', xmlEditorComponent, 'xmleditor')
  console.log("XML Editor plugin installed.")
  // load autocomplete data
  try {
    const res = await fetch(tagDataPath);
    const tagData = await res.json();
    xmlEditorComponent.startAutocomplete(tagData)
    console.log("Loaded autocompletion data...");
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
  }
}

/**
 * component plugin
 */
export const xmlEditorPlugin = {
  name: "xmleditor",
  app: { start }
}

export {XMLEditor}
export default xmlEditorPlugin

import { app, PdfTeiEditor } from '../app.js'
import { JsonListEditor } from '../modules/list-editor.js'

// name of the component
const name = "prompt-editor"

// add prompt-editor in a dialog 
const html = `
<dialog id="dlg-prompt-editor">
  <div class="dialog-header">Edit LLM Prompt</div>
  <div class="dialog-body">
    <p>Below are the parts of the LLM prompt specific to the reference instruction. You can edit, add, remove, 
    enable or disable different parts of the prompt, or change the order of the prompt fragments</p>
    <json-list-editor id="prompt-editor"/>
  </div>
</dialog>`
const dialog = document.createElement("dialog")
dialog.outerHTML = html.trim()
document.body.appendChild(dialog)

/**
 * @type {JsonListEditor}
 */
const promptEditor = $('#prompt-editor');

/**
 * component API
 */
export const promptEditorComponent = {
  load: async () => {
    // load & save prompt data
    data = await this.client.loadInstructions()
    promptEditor.data = data;
  },
  save: async (data) => {
    this.client.saveInstructions(evt.detail)
  }
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent(name, promptEditorComponent, "promptEditor")
  
  // add a button to the command bar
  const button = document.createElement("button")
  button.textContent = "Edit Prompt"
  app.commandbar.add(button, "edit-prompt")

  // show prompt editor
  button.addEventListener("click", () => {
    promptEditor.show()
  })
  // save the editor data when something changes
  promptEditor.addEventListener('data-changed', evt => {
    promptEditorComponent.save(evt.detail)  
  })
  console.log("Prompt editor plugin installed.")
}

/**
 * component plugin
 */
const promptEditorPlugin = {
  name,
  app: { start }
}

export { promptEditorComponent, promptEditorPlugin }
export default promptEditorPlugin
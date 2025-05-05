// this needs to be rewritten with Shoelace

import { app, PdfTeiEditor } from '../app.js'
import { JsonListEditor } from '../modules/list-editor.js'

// name of the component
const componentId = "prompt-editor"

// add prompt-editor in a dialog 
const html = `
<style>
  #${componentId} {
    font: 1em sans-serif;
    border: none;
    border-radius: 5px;
    padding: 20px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    gap: 10px;
    height: 80vh;
  }

  ${componentId} .dialog-header {
    font-size: 1.2em;
    margin-bottom: 10px;
  }

  ${componentId} .dialog-body {
    flex: 1;
    overflow-y: auto;
    margin-bottom: 10px;
  }

  ${componentId} .dialog-footer {
    margin-top: 15px;
    text-align: right;
  }
</style>
<dialog id="${componentId}">
  <div class="dialog-header">Edit LLM Prompt</div>
  <div class="dialog-body">
    <p>Below are the parts of the LLM prompt specific to the reference instruction. You can edit, add, remove, 
    enable or disable different parts of the prompt, or change the order of the prompt fragments</p>
    <json-list-editor></json-list-editor>
  </div>
</dialog>`
const div = document.createElement("div")
div.innerHTML = html.trim()
document.body.appendChild(div)

/**
 * @type {HTMLDialogElement}
 */
const componentNode = document.getElementById(componentId);

/**
 * @type {JsonListEditor}
 */
const promptEditor = componentNode.querySelector("json-list-editor")

/**
 * component API
 */
const promptEditorComponent = {
  show: () => componentNode.showModal(),
  hide: () => componentNode.close(),
  load: async () => {
    data = await this.client.loadInstructions()
    promptEditor.data = data;
  },
  save: async (data) => {
    this.client.saveInstructions(evt.detail)
  }
}

// event handling

// close
promptEditor.addEventListener('close', () => componentNode.close())

// save the editor data when something changes
promptEditor.addEventListener('data-changed', evt => {
  promptEditorComponent.save(evt.detail)
})


/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent(componentId, promptEditorComponent, "promptEditor")

  // add a button to the command bar to show dialog with prompt editor
  const button = document.createElement("button")
  button.textContent = "Edit Prompt"
  app.commandbar.add(button, "edit-prompt")
  button.addEventListener("click", () => {
    componentNode.showModal()
  })
  console.log("Prompt editor component installed.")
}

/**
 * component plugin
 */
const promptEditorPlugin = {
  name: componentId,
  app: { start }
}

export { promptEditorComponent, promptEditorPlugin }
export default promptEditorPlugin


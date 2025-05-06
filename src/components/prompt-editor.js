/**
 * This implements a popup dialog to edit additional instructions included in the 
 * LLM prompt
 */

import '@shoelace-style/shoelace/dist/components/dialog/dialog.js'
import '@shoelace-style/shoelace/dist/components/button/button.js'
import '@shoelace-style/shoelace/dist/components/input/input.js'
import '@shoelace-style/shoelace/dist/components/textarea/textarea.js'
import '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js'
import '@shoelace-style/shoelace/dist/components/menu/menu.js'
import '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js'
import '@shoelace-style/shoelace/dist/components/menu-label/menu-label.js'

import { app, PdfTeiEditor } from '../app.js'


// name of the component
const componentId = "prompt-editor"

// add prompt-editor in a dialog 
const html = `
<sl-dialog id="${componentId}" label="Edit prompt" class="dialog-big">
  <p>Below are the parts of the LLM prompt specific to the reference instruction.</p>
  <div class="dialog-form">
    <sl-dropdown>
      <sl-input slot="trigger" caret></sl-input>
      <sl-menu>
        <sl-menu-item>Dropdown Item 1</sl-menu-item>
        <sl-menu-item>Dropdown Item 2</sl-menu-item>
        <sl-menu-item>Dropdown Item 3</sl-menu-item>
      </sl-menu>
    </sl-dropdown>
    <sl-textarea>
      <slot name="prompt"></slot>
    </sl-texarea>
  </div>
  <sl-button slot="footer" variant="primary">Close</sl-button>
</sl-dialog>
`
const div = document.createElement("div")
div.innerHTML = html.trim()
document.body.appendChild(div.firstChild)

/**
 * @type {HTMLDialogElement}
 */
const componentNode = document.getElementById(componentId);


/**
 * component API
 */
const cmp = {
  show: async () => {
    //data = await this.client.loadInstructions()
    //promptEditor.data = data;
    componentNode.show()
  },
  save: async (data) => {
    //this.client.saveInstructions(evt.detail)
  },
  hide: () => componentNode.close()
}

// event handling


/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(componentId, cmp, "promptEditor")

  // add a button to the command bar to show dialog with prompt editor
  const button = document.createElement("button")
  button.textContent = "Edit Prompt"
  app.commandbar.add(button, "edit-prompt")
  button.addEventListener("click", () => {
    cmp.show()
  })
  app.logger.info("Prompt editor component installed.")
}

/**
 * component plugin
 */
const promptEditorPlugin = {
  name: componentId,
  install
}

export { cmp as promptEditorComponent, promptEditorPlugin }
export default promptEditorPlugin


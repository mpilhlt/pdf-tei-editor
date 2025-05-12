/**
 * This implements a popup dialog to edit additional instructions included in the 
 * LLM prompt
 */

/** @import { ApplicationState } from '../app.js' */
import ui from '../ui.js'
import { logger, client } from '../app.js'
import { SlDialog, SlButton, SlMenu, SlMenuItem, SlTextarea, SlInput } from '../ui.js'

// name of the component
const pluginId = "prompt-editor"

/**
 * Prompt editor
 * @typedef {object} promptEditorComponent
 * @property {SlInput} label
 * @property {SlMenu} labelMenu
 * @property {SlTextarea} text
 * @property {SlButton} cancel
 * @property {SlButton} delete
 * @property {SlButton} duplicate
 * @property {SlButton} submit
 */

// editor dialog
const editorHtml = `
<sl-dialog name="promptEditor" label="Edit prompt" class="dialog-big">
  <p>Below are the parts of the LLM prompt specific to the reference instruction.</p>
  <div class="dialog-column">
    <div class="dialog-row">
      <sl-input name="label" help-text="A short description of the prompt additions"></sl-input>
      <sl-dropdown>
        <sl-button slot="trigger" caret></sl-button>
        <sl-menu name="labelMenu"></sl-menu>
      </sl-dropdown>
    </div>
    <sl-textarea name="text" rows="20"></sl-texarea>
  </div>
  <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
  <sl-button slot="footer" name="delete" disabled variant="danger">Delete prompt</sl-button>
  <sl-button slot="footer" name="duplicate" variant="secondary">Duplicate prompt</sl-button>
  <sl-button slot="footer" name="submit" variant="primary">Save &amp; Close</sl-button>
</sl-dialog>
`

// button, documented in services.js
const buttonHtml = `
<sl-tooltip content="Edit the prompt instructions">
  <sl-button name="editInstructions" size="small">
    <sl-icon name="pencil-square"></sl-icon>
  </sl-button>
</sl-tooltip>
`

/**
 * plugin API
 */
const api = {
  open,
  edit,
  duplicate,
  save,
  submit,
  close,
  delete: deletePrompt
}

/**
 * component plugin
 */
const plugin = {
  name: pluginId,
  deps: ['extraction'],
  install
}

export { api, plugin }
export default plugin

//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} app The main application
 */
function install(app) {
  // add prompt editor component
  const editorDiv = document.createElement("div")
  editorDiv.innerHTML = editorHtml.trim()
  document.body.appendChild(editorDiv.firstChild)
  const pe = ui.promptEditor
  pe.addEventListener("sl-request-close", dialogOnRequestClose)
  pe.labelMenu.addEventListener('sl-select', menuOnSelect);
  pe.submit.addEventListener('click', submit)
  pe.duplicate.addEventListener('click', duplicate)
  pe.cancel.addEventListener('click', close)
  pe.delete.addEventListener('click', deletePrompt)

  // add a button to the command bar to show dialog with prompt editor
  const buttonDiv = document.createElement('div')
  buttonDiv.innerHTML = buttonHtml.trim()
  const button = buttonDiv.firstChild
  button.addEventListener("click", () => api.open())
  ui.toolbar.extractionActions.appendChild(button)
}

// API

/**
 * An array of objects with the different versions of the prompt
 * @type {Array<{ label: string, text: string }>}
 */
let prompts = null;

/** @type {Number} */
let currentIndex = 0

/**
 * Opens the prompt editor dialog
 * todo this needs to always reload the data since it might have changed on the server
 */
async function open() {
  if (prompts === null){
    ui.promptEditor.labelMenu.childNodes.forEach(node => node.remove())
    prompts = await client.loadInstructions()
    for (const [idx, prompt] of prompts.entries()) {
      addSlMenuItem(idx, prompt.label)
    }
  }
  ui.promptEditor.delete.disabled = prompts.length < 2
  api.edit(currentIndex)
  ui.promptEditor.show()
}

/**
 * Shows the prompt with the given index so that the user can edit it
 * @param {Number} idx 
 */
function edit(idx) {
  ui.promptEditor.labelMenu.childNodes[idx].checked = true
  const {label, text} = prompts[idx]
  ui.promptEditor.label.value = label
  ui.promptEditor.text.value = Array.isArray(text) ? text.join("\n") : text
}

/**
 * Duplicates the prompt with the given index
 * @param {Number} idx 
 */
function duplicate(idx) {
  saveCurrentPrompt()
  const newPrompt = Object.assign({}, prompts[currentIndex])
  newPrompt.label += " (Copy)"
  prompts.push(newPrompt)
  ui.promptEditor.labelMenu.childNodes[currentIndex].checked = false
  currentIndex = prompts.length - 1
  addSlMenuItem(currentIndex, newPrompt.label)
  ui.promptEditor.delete.disabled = false
  edit(currentIndex)
}

/**
 * Saves the current prompts to the server
 */
async function save() {
  saveCurrentPrompt()
  client.saveInstructions(prompts)
}

/**
 * Saves the data and closes the prompt editor
 */
function submit() {
  save()
  close()
}

/**
 * Closes the prompt editor
 */
function close() {
  ui.promptEditor.hide()
}

/**
 * Deletes the prompt with the given index 
 * @param {Number} idx 
 * @returns {void}
 */
function deletePrompt(idx){
  if (prompts.length < 2) {
    throw new Error("There must at least be one prompt entry")
  }
  if(!confirm("Do you really want to delete this prompt?"))return
  ui.promptEditor.labelMenu.removeChild(ui.promptEditor.labelMenu.childNodes[currentIndex])
  prompts.splice(currentIndex, 1)
  ui.promptEditor.delete.disabled = prompts.length < 2
  currentIndex--
  edit(currentIndex)
}

// helper methods

function addSlMenuItem(idx, label){
  const slMenuItem = new SlMenuItem()
  slMenuItem.type = "checkbox"
  slMenuItem.value = idx
  slMenuItem.textContent = label
  ui.promptEditor.labelMenu.appendChild(slMenuItem)     
}

function saveCurrentPrompt() {
  const label = ui.promptEditor.label.value
  const text = ui.promptEditor.text.value.split("\n")
  prompts[currentIndex] = {label, text}
  // update menu item
  ui.promptEditor.labelMenu.childNodes[currentIndex].textContent = label
}

// Event listeners

/**
 * Called when the user selects a new prompt from the dropdown. Saves the current values to the prompt data 
 * and changes to the new prompt
 * @param {Event} event The "sl-select" event
 */
function menuOnSelect(event) {
  saveCurrentPrompt()
  const item = event.detail.item;
  ui.promptEditor.labelMenu.childNodes[currentIndex].checked = false
  currentIndex = item.value
  api.edit(currentIndex)
}

/**
 * Called when the dialog is closed
 * @param {Event} event 
 * @returns 
 */
function dialogOnRequestClose(event) {
  if (confirm("Do you really want to close the editor without saving?")) return
  event.preventDefault()
}




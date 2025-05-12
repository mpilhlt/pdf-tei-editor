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

// add prompt-editor in a dialog 
const html = `
<sl-dialog id="${pluginId}" label="Edit prompt" class="dialog-big">
  <p>Below are the parts of the LLM prompt specific to the reference instruction.</p>
  <div class="dialog-column">
    <div class="dialog-row">
      <sl-input name="label" help-text="A short description of the prompt additions"></sl-input>
      <sl-dropdown>
        <sl-button slot="trigger" caret></sl-button>
        <sl-menu></sl-menu>
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

// the following should really be in install() but that wouldn't work because of the closures

const div = document.createElement("div")
div.innerHTML = html.trim()
document.body.appendChild(div.firstChild)

/** @type {SlDialog} */
const slDialogNode = document.getElementById(pluginId);
slDialogNode.addEventListener("sl-request-close", dialogOnRequestClose)

/** @type {SlMenu} */
const slMenuNode = slDialogNode.querySelector('sl-dropdown sl-menu');
slMenuNode.addEventListener('sl-select', menuOnSelect);

/** @type {SlTextarea} */
const slTextareaNode = slDialogNode.querySelector('sl-textarea');

/** @type {SlInput} */
const slInputNode = slDialogNode.querySelector('sl-input')

/** @type {SlButton} */
slDialogNode.querySelector('sl-button[name="submit"]').addEventListener('click', submit)
slDialogNode.querySelector('sl-button[name="duplicate"]').addEventListener('click', duplicate)
slDialogNode.querySelector('sl-button[name="cancel"]').addEventListener('click', close)
const deleteBtn = slDialogNode.querySelector('sl-button[name="delete"]')
deleteBtn.addEventListener('click', deletePrompt)

// button 

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
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  // add a button to the command bar to show dialog with prompt editor
  const div = document.createElement('div')
  div.innerHTML = buttonHtml.trim()
  const button = div.firstChild
  button.addEventListener("click", () => api.open())
  app.ui.toolbar['extractionActions'].appendChild(button)

  logger.info("Prompt editor plugin installed.")
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
    slMenuNode.childNodes.forEach(node => node.remove())
    prompts = await client.loadInstructions()
    for (const [idx, prompt] of prompts.entries()) {
      addSlMenuItem(idx, prompt.label)
    }
  }
  deleteBtn.disabled = prompts.length < 2
  api.edit(currentIndex)
  slDialogNode.show()
}

/**
 * Shows the prompt with the given index so that the user can edit it
 * @param {Number} idx 
 */
function edit(idx) {
  slMenuNode.childNodes[idx].checked = true
  const {label, text} = prompts[idx]
  slInputNode.value = label
  slTextareaNode.value = Array.isArray(text) ? text.join("\n") : text
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
  slMenuNode.childNodes[currentIndex].checked = false
  currentIndex = prompts.length - 1
  addSlMenuItem(currentIndex, newPrompt.label)
  deleteBtn.disabled = false
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

function close() {
  slDialogNode.hide()
}

function deletePrompt(idx){
  if (prompts.length < 2) {
    throw new Error("There must at least be one prompt entry")
  }
  if(!confirm("Do you really want to delete this prompt?"))return
  slMenuNode.removeChild(slMenuNode.childNodes[currentIndex])
  prompts.splice(currentIndex, 1)
  deleteBtn.disabled = prompts.length < 2
  currentIndex--
  edit(currentIndex)
}

// helper methods

function addSlMenuItem(idx, label){
  const slMenuItem = new SlMenuItem()
  slMenuItem.type = "checkbox"
  slMenuItem.value = idx
  slMenuItem.textContent = label
  slMenuNode.appendChild(slMenuItem)     
}

function saveCurrentPrompt() {
  prompts[currentIndex] = {
    label: slInputNode.value,
    text: slTextareaNode.value.split("\n")
  }
  slMenuNode.childNodes[currentIndex].textContent = slInputNode.value
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
  slMenuNode.childNodes[currentIndex].checked = false
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




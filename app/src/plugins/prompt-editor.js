/**
 * This implements a popup dialog to edit additional instructions included in the 
 * LLM prompt
 */

/** @import { ApplicationState } from '../app.js' */
import ui from '../ui.js'
import { logger, client } from '../app.js'
import { createHtmlElements, updateUi, SlDialog, SlButton, SlMenu, SlMenuItem, SlTextarea, SlInput, SlSelect, SlOption } from '../ui.js'


/**
 * plugin API
 */
const api = {
  open,
  edit,
  duplicate: duplicateInstructions,
  save,
  submit,
  close,
  delete: deletePrompt
}

/**
 * Plugin object
 */
const plugin = {
  name: "prompt-editor",
  deps: ['extraction'],
  install
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * Prompt editor
 * @typedef {object} promptEditorComponent
 * @property {SlDialog} self
 * @property {SlInput} label
 * @property {SlMenu} labelMenu
 * @property {SlSelect} extractorSelect
 * @property {SlTextarea} text
 * @property {SlButton} cancel
 * @property {SlButton} delete
 * @property {SlButton} duplicate
 * @property {SlButton} submit
 */

// editor dialog
/** @type {promptEditorComponent} */
const promptEditorDialog = (await createHtmlElements("prompt-editor.html"))[0]

// button, documented in services.js
const promptEditorButton = (await createHtmlElements('prompt-editor-button.html'))[0]

//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state The main application
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  
  // add prompt editor component
  document.body.append(promptEditorDialog)
  updateUi()

  const pe = ui.promptEditor
  pe.self.addEventListener("sl-request-close", dialogOnRequestClose)
  pe.labelMenu.addEventListener('sl-select', menuOnSelect);
  pe.submit.addEventListener('click', submit)
  pe.duplicate.addEventListener('click', duplicateInstructions)
  pe.cancel.addEventListener('click', close)
  pe.delete.addEventListener('click', deletePrompt)

  // add a button to the command bar to show dialog with prompt editor
  ui.toolbar.extractionActions.self.append(promptEditorButton)
  promptEditorButton.addEventListener("click", () => api.open())
}

// API

/**
 * An array of objects with the different versions of the prompt
 * @type {Array<{ label: string, text: string[] }>}
 */
let prompts;

/** @type {Number} */
let currentIndex = 0

/**
 * Opens the prompt editor dialog
 * todo this needs to always reload the data since it might have changed on the server
 */
async function open() {
  if (!prompts){
    ui.promptEditor.labelMenu.childNodes.forEach(node => node.remove())
    prompts = await client.loadInstructions()
    for (const [idx, prompt] of prompts.entries()) {
      addSlMenuItem(idx, prompt.label)
    }
  }
  
  // Load available extractors for the select box
  await populateExtractorSelect()
  
  ui.promptEditor.delete.disabled = prompts.length < 2
  api.edit(currentIndex)
  ui.promptEditor.self.show()
}

/**
 * Populate the extractor select box with available extractors
 */
async function populateExtractorSelect() {
  const extractorSelect = ui.promptEditor.extractorSelect
  extractorSelect.innerHTML = ""
  
  try {
    const extractors = await client.getExtractorList()
    for (const extractor of extractors) {
      const option = Object.assign(new SlOption, {
        value: extractor.id,
        textContent: extractor.name
      })
      extractorSelect.appendChild(option)
    }
  } catch (error) {
    logger.warn("Could not load extractor list for prompt editor:", error)
    // Fallback to default extractor
    const option = Object.assign(new SlOption, {
      value: "llamore-gemini",
      textContent: "LLamore + Gemini"
    })
    extractorSelect.appendChild(option)
  }
}

/**
 * Shows the prompt with the given index so that the user can edit it
 * @param {Number} idx 
 */
function edit(idx) {
  // @ts-ignore
  ui.promptEditor.labelMenu.childNodes[idx].checked = true
  const prompt = prompts[idx]
  const {label, text, extractor = ["llamore-gemini"]} = prompt
  
  ui.promptEditor.label.value = label
  ui.promptEditor.text.value = Array.isArray(text) ? text.join("\n") : text
  
  // Set selected extractors
  ui.promptEditor.extractorSelect.value = extractor
}

/**
 * Duplicates the current prompt
 */
function duplicateInstructions() {
  saveCurrentPrompt()
  const newPrompt = Object.assign({}, prompts[currentIndex])
  newPrompt.label += " (Copy)"
  // Deep copy the extractor array
  newPrompt.extractor = [...(prompts[currentIndex].extractor || ["llamore-gemini"])]
  prompts.push(newPrompt)
  // @ts-ignore
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
  ui.promptEditor.self.hide()
}

/**
 * Deletes the prompt with the given index 
 * @returns {void}
 */
function deletePrompt(){
  if (prompts.length < 2) {
    throw new Error("There must at least be one prompt entry")
  }
  if(!confirm("Do you really want to delete these prompt instructions?")) return
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
  const extractor = ui.promptEditor.extractorSelect.value || ["llamore-gemini"]
  
  prompts[currentIndex] = {label, text, extractor}
  // update menu item
  ui.promptEditor.labelMenu.childNodes[currentIndex].textContent = label
}

// Event listeners

/**
 * Called when the user selects a new prompt from the dropdown. Saves the current values to the prompt data 
 * and changes to the new prompt
 * @param {CustomEvent} event The "sl-select" event
 */
function menuOnSelect(event) {
  saveCurrentPrompt()
  const item = event.detail.item;
  // @ts-ignore
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




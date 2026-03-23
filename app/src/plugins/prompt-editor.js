/**
 * This implements a popup dialog to edit additional instructions included in the
 * LLM prompt
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ui from '../ui.js'
import { registerTemplate, createSingleFromTemplate, updateUi, SlDialog, SlButton, SlMenu, SlMenuItem, SlTextarea, SlInput, SlSelect, SlOption } from '../ui.js'
import { api as clientApi } from './client.js'

/**
 * Prompt editor
 * @typedef {object} promptEditorPart
 * @property {SlInput} label
 * @property {SlMenu} labelMenu
 * @property {SlSelect} extractorSelect
 * @property {SlTextarea} text
 * @property {SlButton} cancel
 * @property {SlButton} delete
 * @property {SlButton} duplicate
 * @property {SlButton} submit
 */

// Register templates at module level
await registerTemplate('prompt-editor', 'prompt-editor.html')
await registerTemplate('prompt-editor-button', 'prompt-editor-button.html')

class PromptEditorPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'prompt-editor', deps: ['extraction', 'logger'] })
  }

  /** @type {Array<{ label: string, text: string[], extractor?: string[] }>|undefined} */
  #prompts

  /** @type {number} */
  #currentIndex = 0

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "prompt-editor"`)

    createSingleFromTemplate('prompt-editor', document.body)
    const promptEditorButton = createSingleFromTemplate('prompt-editor-button')

    const pe = ui.promptEditor
    pe.addEventListener('sl-request-close', e => this.#onDialogRequestClose(e))
    pe.labelMenu.addEventListener('sl-select', e => this.#onMenuSelect(/** @type {CustomEvent} */(e)))
    pe.submit.addEventListener('click', () => this.submit())
    pe.duplicate.addEventListener('click', () => this.duplicate())
    pe.cancel.addEventListener('click', () => this.close())
    pe.delete.addEventListener('click', () => this.delete())

    ui.toolbar.extractionActions.append(promptEditorButton)
    promptEditorButton.addEventListener('click', () => this.open())

    updateUi()
  }

  /**
   * Opens the prompt editor dialog
   */
  async open() {
    if (!this.#prompts) {
      ui.promptEditor.labelMenu.childNodes.forEach(node => node.remove())
      this.#prompts = await clientApi.loadInstructions()
      for (const [idx, prompt] of this.#prompts.entries()) {
        this.#addSlMenuItem(idx, prompt.label)
      }
    }

    await this.#populateExtractorSelect()

    ui.promptEditor.delete.disabled = this.#prompts.length < 2
    this.edit(this.#currentIndex)
    ui.promptEditor.show()
  }

  /**
   * Shows the prompt with the given index for editing
   * @param {number} idx
   */
  edit(idx) {
    // @ts-ignore
    ui.promptEditor.labelMenu.childNodes[idx].checked = true
    const prompt = this.#prompts[idx]
    const { label, text, extractor = ['llamore-gemini'] } = prompt

    ui.promptEditor.label.value = label
    ui.promptEditor.text.value = Array.isArray(text) ? text.join('\n') : text
    ui.promptEditor.extractorSelect.value = extractor
  }

  /**
   * Duplicates the current prompt
   */
  duplicate() {
    this.#saveCurrentPrompt()
    const newPrompt = Object.assign({}, this.#prompts[this.#currentIndex])
    newPrompt.label += ' (Copy)'
    newPrompt.extractor = [...(this.#prompts[this.#currentIndex].extractor || ['llamore-gemini'])]
    this.#prompts.push(newPrompt)
    // @ts-ignore
    ui.promptEditor.labelMenu.childNodes[this.#currentIndex].checked = false
    this.#currentIndex = this.#prompts.length - 1
    this.#addSlMenuItem(this.#currentIndex, newPrompt.label)
    ui.promptEditor.delete.disabled = false
    this.edit(this.#currentIndex)
  }

  /**
   * Saves the current prompts to the server
   */
  async save() {
    this.#saveCurrentPrompt()
    clientApi.saveInstructions(this.#prompts)
  }

  /**
   * Saves and closes the prompt editor
   */
  submit() {
    this.save()
    this.close()
  }

  /**
   * Closes the prompt editor
   */
  close() {
    ui.promptEditor.hide()
  }

  /**
   * Deletes the current prompt
   */
  delete() {
    if (this.#prompts.length < 2) {
      throw new Error('There must at least be one prompt entry')
    }
    if (!confirm('Do you really want to delete these prompt instructions?')) return
    ui.promptEditor.labelMenu.removeChild(ui.promptEditor.labelMenu.childNodes[this.#currentIndex])
    this.#prompts.splice(this.#currentIndex, 1)
    ui.promptEditor.delete.disabled = this.#prompts.length < 2
    this.#currentIndex--
    this.edit(this.#currentIndex)
  }

  async #populateExtractorSelect() {
    const extractorSelect = ui.promptEditor.extractorSelect
    extractorSelect.innerHTML = ''

    try {
      const extractors = await clientApi.getExtractorList()
      for (const extractor of extractors) {
        const option = Object.assign(new SlOption, {
          value: extractor.id,
          textContent: extractor.name
        })
        extractorSelect.appendChild(option)
      }
    } catch (error) {
      this.getDependency('logger').warn('Could not load extractor list for prompt editor:', error)
      const option = Object.assign(new SlOption, {
        value: 'llamore-gemini',
        textContent: 'LLamore + Gemini'
      })
      extractorSelect.appendChild(option)
    }
  }

  /**
   * @param {number} idx
   * @param {string} label
   */
  #addSlMenuItem(idx, label) {
    const slMenuItem = new SlMenuItem()
    slMenuItem.type = 'checkbox'
    slMenuItem.value = idx
    slMenuItem.textContent = label
    ui.promptEditor.labelMenu.appendChild(slMenuItem)
  }

  #saveCurrentPrompt() {
    const label = ui.promptEditor.label.value
    const text = ui.promptEditor.text.value.split('\n')
    const extractor = ui.promptEditor.extractorSelect.value || ['llamore-gemini']
    this.#prompts[this.#currentIndex] = { label, text, extractor }
    ui.promptEditor.labelMenu.childNodes[this.#currentIndex].textContent = label
  }

  /**
   * @param {CustomEvent} event
   */
  #onMenuSelect(event) {
    this.#saveCurrentPrompt()
    const item = event.detail.item
    // @ts-ignore
    ui.promptEditor.labelMenu.childNodes[this.#currentIndex].checked = false
    this.#currentIndex = item.value
    this.edit(this.#currentIndex)
  }

  /**
   * @param {Event} event
   */
  #onDialogRequestClose(event) {
    if (confirm('Do you really want to close the editor without saving?')) return
    event.preventDefault()
  }
}

export default PromptEditorPlugin

export const plugin = PromptEditorPlugin

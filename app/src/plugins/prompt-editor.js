/**
 * This implements a popup dialog to edit additional instructions included in the
 * LLM prompt
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { promptEditorPart } from '../templates/prompt-editor.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { SlMenuItem, SlOption } from '../ui.js'

// Register templates at module level
await registerTemplate('prompt-editor', 'prompt-editor.html')
await registerTemplate('prompt-editor-button', 'prompt-editor-button.html')

class PromptEditorPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'prompt-editor', deps: ['extraction', 'logger'] })
  }

  get #client() { return this.getDependency('client') }

  /** @type {import('../ui.js').SlDialog & promptEditorPart} */
  #ui = null

  /** @type {Array<{ label: string, text: string[], extractor?: string[] }>|undefined} */
  #prompts

  /** @type {number} */
  #currentIndex = 0

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "prompt-editor"`)

    const dialog = createSingleFromTemplate('prompt-editor', document.body)
    this.#ui = this.createUi(dialog)

    this.#ui.addEventListener('sl-request-close', e => this.#onDialogRequestClose(e))
    this.#ui.labelMenu.addEventListener('sl-select', e => this.#onMenuSelect(/** @type {CustomEvent} */(e)))
    this.#ui.submit.addEventListener('click', () => this.submit())
    this.#ui.duplicate.addEventListener('click', () => this.duplicate())
    this.#ui.cancel.addEventListener('click', () => this.close())
    this.#ui.delete.addEventListener('click', () => this.delete())

    const promptEditorButton = createSingleFromTemplate('prompt-editor-button')
    this.getDependency('extraction').addButton(promptEditorButton)
    promptEditorButton.addEventListener('click', () => this.open())
  }

  /**
   * Opens the prompt editor dialog
   */
  async open() {
    if (!this.#prompts) {
      this.#ui.labelMenu.childNodes.forEach(node => node.remove())
      this.#prompts = await this.#client.loadInstructions()
      for (const [idx, prompt] of this.#prompts.entries()) {
        this.#addSlMenuItem(idx, prompt.label)
      }
    }

    await this.#populateExtractorSelect()

    this.#ui.delete.disabled = this.#prompts.length < 2
    this.edit(this.#currentIndex)
    this.#ui.show()
  }

  /**
   * Shows the prompt with the given index for editing
   * @param {number} idx
   */
  edit(idx) {
    // @ts-ignore
    this.#ui.labelMenu.childNodes[idx].checked = true
    const prompt = this.#prompts[idx]
    const { label, text, extractor = ['llamore-gemini'] } = prompt

    this.#ui.label.value = label
    this.#ui.text.value = Array.isArray(text) ? text.join('\n') : text
    this.#ui.extractorSelect.value = extractor
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
    this.#ui.labelMenu.childNodes[this.#currentIndex].checked = false
    this.#currentIndex = this.#prompts.length - 1
    this.#addSlMenuItem(this.#currentIndex, newPrompt.label)
    this.#ui.delete.disabled = false
    this.edit(this.#currentIndex)
  }

  /**
   * Saves the current prompts to the server
   */
  async save() {
    this.#saveCurrentPrompt()
    this.#client.saveInstructions(this.#prompts)
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
    this.#ui.hide()
  }

  /**
   * Deletes the current prompt
   */
  delete() {
    if (this.#prompts.length < 2) {
      throw new Error('There must at least be one prompt entry')
    }
    if (!confirm('Do you really want to delete these prompt instructions?')) return
    this.#ui.labelMenu.removeChild(this.#ui.labelMenu.childNodes[this.#currentIndex])
    this.#prompts.splice(this.#currentIndex, 1)
    this.#ui.delete.disabled = this.#prompts.length < 2
    this.#currentIndex--
    this.edit(this.#currentIndex)
  }

  async #populateExtractorSelect() {
    const extractorSelect = this.#ui.extractorSelect
    extractorSelect.innerHTML = ''

    try {
      const extractors = await this.#client.getExtractorList()
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
    this.#ui.labelMenu.appendChild(slMenuItem)
  }

  #saveCurrentPrompt() {
    const label = this.#ui.label.value
    const text = this.#ui.text.value.split('\n')
    const extractor = this.#ui.extractorSelect.value || ['llamore-gemini']
    this.#prompts[this.#currentIndex] = { label, text, extractor }
    this.#ui.labelMenu.childNodes[this.#currentIndex].textContent = label
  }

  /**
   * @param {CustomEvent} event
   */
  #onMenuSelect(event) {
    this.#saveCurrentPrompt()
    const item = event.detail.item
    // @ts-ignore
    this.#ui.labelMenu.childNodes[this.#currentIndex].checked = false
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

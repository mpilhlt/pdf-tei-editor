/**
 * Tools Plugin
 *
 * Provides the "Tools" button group in the toolbar. The group contains:
 * - A native split button whose menu is populated at runtime by frontend plugins
 *   via `addMenuItems()` / `clearMenuItems()`.
 * - Any additional split buttons or controls added by other plugins via
 *   `addButton()` / `removeButton()` (e.g. the backend-plugins plugin).
 *
 * The button group is hidden when all its children are hidden, and visible
 * as soon as any child becomes visible.
 *
 * Items added to the native menu can optionally be grouped under a named category
 * label. The label is created automatically the first time a category is used, and
 * is hidden automatically via MutationObserver when all items in that category are
 * hidden by the calling plugin.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDropdown, SlButton, SlMenu } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ui, { updateUi } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'

// Register template
await registerTemplate('tools-button', 'tools-button.html')

/**
 * Tools button group UI structure (native split button only).
 * Additional buttons added by other plugins are not typed here.
 * @typedef {object} toolsGroupPart
 * @property {SlDropdown} toolsDropdown - Native frontend dropdown (hidden when menu is empty)
 * @property {SlButton} toolsBtn - Trigger button for the native dropdown
 * @property {SlMenu} toolsMenu - Menu populated by frontend plugins
 */

class ToolsPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tools', deps: ['logger'] })
  }

  /** @type {HTMLElement[]} */
  #uncategorizedItems = []

  /**
   * @type {Map<string, {label: HTMLElement, divider: HTMLElement|null, items: HTMLElement[]}>}
   */
  #categoryGroups = new Map()

  /** MutationObserver that hides/shows category labels when items are toggled. */
  #observer = new MutationObserver(() => {
    this.#updateAllCategoryLabels()
    this.#updateNativeDropdown()
    this.#updateGroupVisibility()
  })

  /** @returns {Element} The native frontend tools menu element */
  get menu() {
    return ui.toolbar.toolsGroup.querySelector('[name="toolsMenu"]')
  }

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    const logger = this.getDependency('logger')
    logger.debug(`Installing plugin "tools"`)
  }

  /**
   * Adds the tools button group to the toolbar.
   */
  async start() {
    const logger = this.getDependency('logger')
    logger.debug(`Starting plugin "tools"`)

    const buttonElement = createSingleFromTemplate('tools-button')
    ui.toolbar.add(buttonElement, 0, -2)
    updateUi()
  }

  /**
   * Add menu items to the native frontend dropdown.
   * @param {HTMLElement[]} elements - Items to add
   * @param {string} [category] - Optional category name. A formatted label is inserted
   *   automatically and hidden via MutationObserver when all its items are hidden.
   */
  addMenuItems(elements, category) {
    const menu = ui.toolbar.toolsGroup.querySelector('[name="toolsMenu"]')

    if (category) {
      let group = this.#categoryGroups.get(category)
      if (!group) {
        let divider = null
        if (menu.children.length > 0) {
          divider = document.createElement('sl-divider')
          menu.appendChild(divider)
        }
        const label = document.createElement('small')
        label.textContent = this.#formatCategoryName(category)
        menu.appendChild(label)
        group = { label, divider, items: [] }
        this.#categoryGroups.set(category, group)
      }
      elements.forEach(el => {
        menu.appendChild(el)
        group.items.push(el)
        this.#observer.observe(el, { attributes: true, attributeFilter: ['style'] })
      })
    } else {
      elements.forEach(el => {
        menu.appendChild(el)
        this.#uncategorizedItems.push(el)
        this.#observer.observe(el, { attributes: true, attributeFilter: ['style'] })
      })
    }

    this.#updateAllCategoryLabels()
    this.#updateNativeDropdown()
  }

  /**
   * Clear all items (and category labels) from the native frontend dropdown.
   */
  clearMenuItems() {
    this.#observer.disconnect()
    const menu = ui.toolbar.toolsGroup.querySelector('[name="toolsMenu"]')
    menu.innerHTML = ''
    this.#uncategorizedItems.length = 0
    this.#categoryGroups.clear()
    this.#updateNativeDropdown()
  }

  /**
   * Add a button or split-button element to the tools button group.
   * @param {HTMLElement} element
   */
  addButton(element) {
    ui.toolbar.toolsGroup.appendChild(element)
    this.#updateGroupVisibility()
  }

  /**
   * Remove a button or split-button element from the tools button group.
   * @param {HTMLElement} element
   */
  removeButton(element) {
    if (element.parentNode === ui.toolbar.toolsGroup) {
      ui.toolbar.toolsGroup.removeChild(element)
    }
    this.#updateGroupVisibility()
  }

  /**
   * Show/hide the tools button group based on child visibility.
   */
  updateVisibility() {
    this.#updateGroupVisibility()
  }

  /** Show/hide category labels based on whether their items are all hidden. */
  #updateAllCategoryLabels() {
    this.#categoryGroups.forEach(group => {
      const allHidden = group.items.every(el => el.style.display === 'none')
      group.label.style.display = allHidden ? 'none' : ''
      if (group.divider) group.divider.style.display = allHidden ? 'none' : ''
    })
  }

  /** Show/hide the native dropdown based on whether any tracked menu item is visible. */
  #updateNativeDropdown() {
    const dropdown = ui.toolbar.toolsGroup.querySelector('[name="toolsDropdown"]')
    const allItems = [...this.#uncategorizedItems, ...[...this.#categoryGroups.values()].flatMap(g => g.items)]
    const hasVisibleItem = allItems.some(el => el.style.display !== 'none')
    dropdown.style.display = hasVisibleItem ? '' : 'none'
    this.#updateGroupVisibility()
  }

  /** Show the button group when at least one child is visible; hide it otherwise. */
  #updateGroupVisibility() {
    const group = ui.toolbar.toolsGroup
    const hasVisibleChild = Array.from(group.children).some(el => el.style.display !== 'none')
    group.style.display = hasVisibleChild ? 'inline-flex' : 'none'
  }

  /**
   * Format a category key into a display label.
   * @param {string} category
   * @returns {string}
   */
  #formatCategoryName(category) {
    return category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
}

export default ToolsPlugin

/** @deprecated Use getDependency('tools') instead */
export const api = new Proxy({}, {
  get(_, prop) {
    const instance = ToolsPlugin.getInstance()
    const value = instance[prop]
    return typeof value === 'function' ? value.bind(instance) : value
  },
  set(_, prop, value) {
    ToolsPlugin.getInstance()[prop] = value
    return true
  }
})

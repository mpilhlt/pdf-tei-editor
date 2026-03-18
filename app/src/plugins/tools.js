/**
 * Tools Plugin
 *
 * Provides the "Tools" button group in the toolbar. The group contains:
 * - A native split button whose menu is populated at runtime by frontend plugins
 *   via `api.addMenuItems()` / `api.clearMenuItems()`.
 * - Any additional split buttons or controls added by other plugins via
 *   `api.addButton()` / `api.removeButton()` (e.g. the backend-plugins plugin).
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
 * @import { ApplicationState } from '../state.js'
 * @import { SlDropdown, SlButton, SlMenu } from '../ui.js'
 */

import { logger } from '../app.js';
import ui, { updateUi } from '../ui.js';
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js';

// Register template
await registerTemplate('tools-button', 'tools-button.html');

/**
 * Tools button group UI structure (native split button only).
 * Additional buttons added by other plugins are not typed here.
 * @typedef {object} toolsGroupPart
 * @property {SlDropdown} toolsDropdown - Native frontend dropdown (hidden when menu is empty)
 * @property {SlButton} toolsBtn - Trigger button for the native dropdown
 * @property {SlMenu} toolsMenu - Menu populated by frontend plugins
 */

/**
 * Tracks items added without a category.
 * @type {HTMLElement[]}
 */
const _uncategorizedItems = [];

/**
 * Tracks items and DOM nodes for each named category.
 * @type {Map<string, {label: HTMLElement, divider: HTMLElement|null, items: HTMLElement[]}>}
 */
const _categoryGroups = new Map();

/**
 * MutationObserver that hides/shows category labels when items are toggled.
 */
const _observer = new MutationObserver(() => {
  _updateAllCategoryLabels();
  _updateNativeDropdown();
  _updateGroupVisibility();
});

const plugin = {
  name: 'tools',
  install,
  start,
  get api() { return api; }
};

const api = {
  addMenuItems,
  clearMenuItems,
  addButton,
  removeButton,
  updateVisibility: _updateGroupVisibility,
  /** @returns {Element} The native frontend tools menu element */
  get menu() {
    return ui.toolbar.toolsGroup.querySelector('[name="toolsMenu"]');
  }
};

export { plugin, api };

/**
 * @param {ApplicationState} _state
 */
async function install(_state) {
  logger.debug(`Installing plugin "${plugin.name}"`);
}

/**
 * Adds the tools button group to the toolbar and wires up the z-index fix.
 */
async function start() {
  logger.debug(`Starting plugin "${plugin.name}"`);

  const buttonElement = createSingleFromTemplate('tools-button');
  ui.toolbar.add(buttonElement, 0, -2);
  updateUi();

}

/**
 * Add menu items to the native frontend dropdown.
 * @param {HTMLElement[]} elements - Items to add
 * @param {string} [category] - Optional category name. A formatted label is inserted
 *   automatically and hidden via MutationObserver when all its items are hidden.
 */
function addMenuItems(elements, category) {
  const menu = ui.toolbar.toolsGroup.querySelector('[name="toolsMenu"]');

  if (category) {
    let group = _categoryGroups.get(category);
    if (!group) {
      // Insert a divider before the new category when the menu already has content
      let divider = null;
      if (menu.children.length > 0) {
        divider = document.createElement('sl-divider');
        menu.appendChild(divider);
      }
      const label = document.createElement('small');
      label.textContent = _formatCategoryName(category);
      menu.appendChild(label);
      group = { label, divider, items: [] };
      _categoryGroups.set(category, group);
    }
    elements.forEach(el => {
      menu.appendChild(el);
      group.items.push(el);
      _observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    });
  } else {
    elements.forEach(el => {
      menu.appendChild(el);
      _uncategorizedItems.push(el);
      _observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    });
  }

  _updateAllCategoryLabels();
  _updateNativeDropdown();
}

/**
 * Clear all items (and category labels) from the native frontend dropdown.
 */
function clearMenuItems() {
  _observer.disconnect();
  const menu = ui.toolbar.toolsGroup.querySelector('[name="toolsMenu"]');
  menu.innerHTML = '';
  _uncategorizedItems.length = 0;
  _categoryGroups.clear();
  _updateNativeDropdown();
}

/**
 * Add a button or split-button element to the tools button group.
 * @param {HTMLElement} element
 */
function addButton(element) {
  ui.toolbar.toolsGroup.appendChild(element);
  _updateGroupVisibility();
}

/**
 * Remove a button or split-button element from the tools button group.
 * @param {HTMLElement} element
 */
function removeButton(element) {
  if (element.parentNode === ui.toolbar.toolsGroup) {
    ui.toolbar.toolsGroup.removeChild(element);
  }
  _updateGroupVisibility();
}

/**
 * Show/hide category labels based on whether their items are all hidden.
 */
function _updateAllCategoryLabels() {
  _categoryGroups.forEach(group => {
    const allHidden = group.items.every(el => el.style.display === 'none');
    group.label.style.display = allHidden ? 'none' : '';
    if (group.divider) group.divider.style.display = allHidden ? 'none' : '';
  });
}

/**
 * Show/hide the native dropdown based on whether any tracked menu item is visible.
 */
function _updateNativeDropdown() {
  const dropdown = ui.toolbar.toolsGroup.querySelector('[name="toolsDropdown"]');
  const allItems = [..._uncategorizedItems, ...[..._categoryGroups.values()].flatMap(g => g.items)];
  const hasVisibleItem = allItems.some(el => el.style.display !== 'none');
  dropdown.style.display = hasVisibleItem ? '' : 'none';
  _updateGroupVisibility();
}

/**
 * Show the button group when at least one child is visible; hide it otherwise.
 */
function _updateGroupVisibility() {
  const group = ui.toolbar.toolsGroup;
  const hasVisibleChild = Array.from(group.children).some(el => el.style.display !== 'none');
  group.style.display = hasVisibleChild ? 'inline-flex' : 'none';
}

/**
 * Format a category key into a display label.
 * @param {string} category
 * @returns {string}
 */
function _formatCategoryName(category) {
  return category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

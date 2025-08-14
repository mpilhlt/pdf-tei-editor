/**
 * MenuBar component for SlMenu/SlDropdown containers with hamburger overflow
 * Extends BasePanel to provide menubar-specific functionality
 */

import { BasePanel } from './base-panel.js';

class MenuBar extends BasePanel {
  constructor() {
    super();
    this.hamburgerMenu = null;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          align-items: center;
          height: 32px;
          padding: 4px 8px;
          background-color: var(--sl-color-neutral-0);
          border-bottom: 1px solid var(--sl-color-neutral-200);
          gap: 4px;
          overflow: hidden;
          font-size: var(--sl-font-size-small);
        }

        ::slotted(*) {
          flex-shrink: 0;
        }

        /* Dynamic overflow hiding - applied via JavaScript */
        ::slotted([data-overflow-hidden]) {
          display: none !important;
        }

        .overflow-container {
          position: relative;
          display: inline-flex;
          align-items: center;
        }

        .hamburger-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          cursor: pointer;
          border: 1px solid var(--sl-color-neutral-300);
          border-radius: var(--sl-border-radius-medium);
          background: var(--sl-color-neutral-0);
          color: var(--sl-color-neutral-700);
        }

        .hamburger-button:hover {
          background: var(--sl-color-neutral-50);
          border-color: var(--sl-color-neutral-400);
        }

        .hamburger-icon {
          font-size: 14px;
        }

        .hamburger-menu {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 2px;
          min-width: 180px;
          max-height: 400px;
          overflow-y: auto;
          background: var(--sl-color-neutral-0);
          border: 1px solid var(--sl-color-neutral-200);
          border-radius: var(--sl-border-radius-medium);
          box-shadow: var(--sl-shadow-large);
          z-index: 1000;
          display: none;
          padding: 4px;
        }

        .hamburger-menu[data-visible] {
          display: block;
        }

        .hamburger-menu-item {
          display: block;
          width: 100%;
          padding: 8px 12px;
          border: none;
          background: transparent;
          cursor: pointer;
          border-radius: var(--sl-border-radius-small);
          font-size: var(--sl-font-size-small);
          color: var(--sl-color-neutral-700);
          text-align: left;
          margin-bottom: 2px;
        }

        .hamburger-menu-item:hover {
          background: var(--sl-color-neutral-100);
        }

        .hamburger-menu-item:last-child {
          margin-bottom: 0;
        }
      </style>
      
      <slot></slot>
    `;
  }

  createOverflowContainer() {
    if (this.overflowContainer) return this.overflowContainer;

    const dropdown = document.createElement('sl-dropdown');
    dropdown.setAttribute('data-overflow-hidden', ''); // Initially hidden

    const trigger = document.createElement('sl-button');
    trigger.slot = 'trigger';
    trigger.size = 'small';
    trigger.variant = 'text';
    trigger.innerHTML = '<sl-icon name="list"></sl-icon>'; // <sl-icon name="list"></sl-icon>
    trigger.setAttribute('title', 'More menus');

    const menu = document.createElement('sl-menu');

    dropdown.appendChild(trigger);
    dropdown.appendChild(menu);

    this.overflowContainer = dropdown;
    this.hamburgerMenu = menu;
    this.appendChild(dropdown);

    return dropdown;
  }

  updateOverflowContainer(hiddenWidgets) {
    if (!this.overflowContainer) {
      if (hiddenWidgets.length > 0) {
        this.createOverflowContainer();
      } else {
        return;
      }
    }

    // Clear existing menu items
    this.hamburgerMenu.innerHTML = '';

    if (hiddenWidgets.length === 0) {
      this.overflowContainer.setAttribute('data-overflow-hidden', '');
      return;
    }

    this.overflowContainer.removeAttribute('data-overflow-hidden');

    // Sort hidden widgets by priority (highest first) for menu display
    hiddenWidgets.sort((a, b) => b.priority - a.priority);

    // Recreate the hamburger menu with hierarchical structure
    hiddenWidgets.forEach(widget => {
      if (widget.element.tagName === 'SL-DROPDOWN') {
        this.createHierarchicalMenuItem(widget.element);
      } else {
        // For non-dropdown widgets, create a simple menu item
        const menuItem = document.createElement('sl-menu-item');
        const label = this.getMenuLabel(widget.element);
        menuItem.textContent = label;
        
        menuItem.addEventListener('click', (e) => {
          e.stopPropagation();
          const clickEvent = new Event('click', { bubbles: true });
          widget.element.dispatchEvent(clickEvent);
        });
        
        this.hamburgerMenu.appendChild(menuItem);
      }
    });
  }

  /**
   * Create a hierarchical menu item with submenu for a dropdown element
   * @param {HTMLElement} originalDropdown - The original dropdown element
   */
  createHierarchicalMenuItem(originalDropdown) {
    // Get the menu label
    const label = this.getMenuLabel(originalDropdown);
    
    // Create the top-level menu item
    const parentMenuItem = document.createElement('sl-menu-item');
    parentMenuItem.textContent = label;
    
    // Find the original menu content
    const originalMenu = originalDropdown.querySelector('sl-menu');
    if (originalMenu) {
      // Create a submenu
      const submenu = document.createElement('sl-menu');
      submenu.slot = 'submenu';
      
      // Copy all original menu items recursively
      this.copyMenuItemsRecursively(originalMenu, submenu, originalDropdown);
      
      // Add the submenu to the parent menu item
      parentMenuItem.appendChild(submenu);
    }
    
    // Add to the hamburger menu
    this.hamburgerMenu.appendChild(parentMenuItem);
  }
  
  /**
   * Recursively copy menu items and maintain references to originals
   * @param {HTMLElement} sourceMenu - Source menu to copy from
   * @param {HTMLElement} targetMenu - Target menu to copy to  
   * @param {HTMLElement} originalDropdown - The original dropdown for event context
   */
  copyMenuItemsRecursively(sourceMenu, targetMenu, originalDropdown) {
    const originalItems = sourceMenu.querySelectorAll(':scope > sl-menu-item');
    
    originalItems.forEach(originalItem => {
      const copiedItem = document.createElement('sl-menu-item');
      
      // Copy text content
      copiedItem.textContent = originalItem.textContent;
      
      // Copy attributes that affect appearance
      if (originalItem.disabled) copiedItem.disabled = true;
      if (originalItem.value) copiedItem.value = originalItem.value;
      
      // Check if this item has a submenu
      const originalSubmenu = originalItem.querySelector('sl-menu[slot="submenu"]');
      if (originalSubmenu) {
        // Recursively handle submenu
        const copiedSubmenu = document.createElement('sl-menu');
        copiedSubmenu.slot = 'submenu';
        this.copyMenuItemsRecursively(originalSubmenu, copiedSubmenu, originalDropdown);
        copiedItem.appendChild(copiedSubmenu);
      } else {
        // This is a leaf item - add click handler to trigger original
        copiedItem.addEventListener('click', (e) => {
          e.stopPropagation();
          
          // Close the hamburger menu first
          this.overflowContainer.hide?.();
          
          // Trigger sl-select event on the original menu with the original item
          setTimeout(() => {
            const selectEvent = new CustomEvent('sl-select', {
              bubbles: true,
              detail: { item: originalItem }
            });
            originalDropdown.dispatchEvent(selectEvent);
            
            // Also trigger click on the original item for compatibility
            originalItem.click();
          }, 100);
        });
      }
      
      targetMenu.appendChild(copiedItem);
    });
  }

  /**
   * Extract menu label from widget element
   * @param {HTMLElement} element 
   * @returns {string}
   */
  getMenuLabel(element) {
    // Try different ways to get a meaningful label
    if (element.getAttribute && element.getAttribute('label')) {
      return element.getAttribute('label');
    }
    
    // For sl-dropdown, look for trigger text
    if (element.tagName === 'SL-DROPDOWN') {
      const trigger = element.querySelector('[slot="trigger"]');
      if (trigger) {
        return trigger.textContent || trigger.getAttribute('text') || 'Menu';
      }
    }
    
    // Fallback to textContent or generic label
    return element.textContent || element.getAttribute('text') || 'Menu';
  }

  /**
   * Add a menu to the menubar
   * @param {string|HTMLElement|Object} menu - Menu label, element, or options object
   * @param {Array|HTMLElement} items - Menu items or menu element
   * @param {number} priority - Higher priority menus stay visible longer
   */
  addMenu(menu, items = [], priority = 0) {
    let menuElement;

    // If menu is a string (label), create sl-dropdown
    if (typeof menu === 'string') {
      menuElement = document.createElement('sl-dropdown');
      menuElement.setAttribute('label', menu);
      
      const trigger = document.createElement('sl-button');
      trigger.slot = 'trigger';
      trigger.textContent = menu;
      trigger.variant = 'text';
      trigger.size = 'small';
      
      const menuContainer = document.createElement('sl-menu');
      
      // Add menu items
      if (Array.isArray(items)) {
        items.forEach(item => {
          const menuItem = document.createElement('sl-menu-item');
          if (typeof item === 'string') {
            menuItem.textContent = item;
          } else if (item.text) {
            menuItem.textContent = item.text;
            if (item.value) menuItem.value = item.value;
            if (item.disabled) menuItem.disabled = item.disabled;
            if (item.action) {
              menuItem.addEventListener('click', () => {
                this.dispatchEvent(new CustomEvent('panel-action', {
                  bubbles: true,
                  detail: { action: item.action, widget: menuItem }
                }));
              });
            }
          }
          menuContainer.appendChild(menuItem);
        });
      }
      
      menuElement.appendChild(trigger);
      menuElement.appendChild(menuContainer);
      
    } else if (typeof menu === 'object' && !menu.tagName) {
      // Menu is options object
      menuElement = document.createElement('sl-dropdown');
      menuElement.setAttribute('label', menu.label || 'Menu');
      
      const trigger = document.createElement('sl-button');
      trigger.slot = 'trigger';
      trigger.textContent = menu.label || 'Menu';
      trigger.variant = 'text';
      trigger.size = 'small';
      
      const menuContainer = document.createElement('sl-menu');
      
      // Add items from options
      if (menu.items && Array.isArray(menu.items)) {
        menu.items.forEach(item => {
          const menuItem = document.createElement('sl-menu-item');
          if (typeof item === 'string') {
            menuItem.textContent = item;
          } else if (item.text) {
            menuItem.textContent = item.text;
            if (item.value) menuItem.value = item.value;
            if (item.disabled) menuItem.disabled = item.disabled;
            if (item.action) {
              menuItem.addEventListener('click', () => {
                this.dispatchEvent(new CustomEvent('panel-action', {
                  bubbles: true,
                  detail: { action: item.action, widget: menuItem }
                }));
              });
            }
          }
          menuContainer.appendChild(menuItem);
        });
      }
      
      menuElement.appendChild(trigger);
      menuElement.appendChild(menuContainer);
      
    } else {
      // Menu is already an element
      menuElement = menu;
    }

    return this.addWidget(menuElement, priority);
  }
}

customElements.define('menu-bar', MenuBar);

export { MenuBar };
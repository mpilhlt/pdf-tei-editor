/**
 * ToolBar component for SlButton containers with >> overflow
 * Extends BasePanel to provide toolbar-specific functionality
 */

import { BasePanel } from './base-panel.js';

class ToolBar extends BasePanel {
  constructor() {
    super();
    this.overflowMenu = null;
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

        .overflow-button {
          display: inline-flex;
          align-items: center;
          padding: 4px 6px;
          font-size: var(--sl-font-size-small);
          cursor: pointer;
          border: 1px solid var(--sl-color-neutral-300);
          border-radius: var(--sl-border-radius-medium);
          background: var(--sl-color-neutral-0);
          color: var(--sl-color-neutral-700);
          min-height: 24px;
        }

        .overflow-button:hover {
          background: var(--sl-color-neutral-50);
          border-color: var(--sl-color-neutral-400);
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
    trigger.innerHTML = '&raquo;';
    trigger.setAttribute('title', 'More tools');

    const menu = document.createElement('sl-menu');
    menu.style.minWidth = '200px';

    dropdown.appendChild(trigger);
    dropdown.appendChild(menu);

    this.overflowContainer = dropdown;
    this.overflowMenu = menu;
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
    this.overflowMenu.innerHTML = '';

    if (hiddenWidgets.length === 0) {
      this.overflowContainer.setAttribute('data-overflow-hidden', '');
      return;
    }

    this.overflowContainer.removeAttribute('data-overflow-hidden');

    // Sort hidden widgets by priority (highest first) for menu display
    hiddenWidgets.sort((a, b) => b.priority - a.priority);

    // Create menu items for hidden buttons instead of moving the actual buttons
    hiddenWidgets.forEach(widget => {
      const menuItem = document.createElement('sl-menu-item');
      
      // Copy button text and icon if available
      const buttonText = widget.element.textContent?.trim() || widget.element.getAttribute('text')?.trim() || '';
      const icon = widget.element.querySelector('sl-icon');
      
      if (icon) {
        const menuIcon = icon.cloneNode(true);
        menuItem.appendChild(menuIcon);
      }
      
      // Always add text node, even if empty - this ensures proper menu item structure
      const textNode = document.createTextNode(buttonText);
      menuItem.appendChild(textNode);
      
      // Handle menu item clicks to trigger original button
      menuItem.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close the dropdown first
        this.overflowContainer.hide?.();
        // Then trigger the original button click
        setTimeout(() => {
          const clickEvent = new Event('click', { bubbles: true });
          widget.element.dispatchEvent(clickEvent);
        }, 100);
      });
      
      this.overflowMenu.appendChild(menuItem);
    });
  }

  /**
   * Add a button to the toolbar
   * @param {HTMLElement|Object} button - Button element or options object
   * @param {number} priority - Higher priority buttons stay visible longer
   */
  addButton(button, priority = 0) {
    // If button is options object, create sl-button
    if (typeof button === 'object' && !button.tagName) {
      const btnElement = document.createElement('sl-button');
      
      // Apply button properties
      if (button.text) btnElement.textContent = button.text;
      if (button.variant) btnElement.variant = button.variant;
      if (button.size) btnElement.size = button.size;
      if (button.disabled) btnElement.disabled = button.disabled;
      if (button.outline) btnElement.outline = button.outline;
      if (button.pill) btnElement.pill = button.pill;
      if (button.circle) btnElement.circle = button.circle;
      if (button.loading) btnElement.loading = button.loading;
      
      // Handle action/click
      if (button.action) {
        btnElement.addEventListener('click', () => {
          this.dispatchEvent(new CustomEvent('panel-action', {
            bubbles: true,
            detail: { action: button.action, widget: btnElement }
          }));
        });
      }

      button = btnElement;
    }

    return this.addWidget(button, priority);
  }
}

customElements.define('tool-bar', ToolBar);

export { ToolBar };
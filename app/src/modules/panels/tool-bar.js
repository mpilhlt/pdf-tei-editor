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

  static get observedAttributes() {
    return ['smart-overflow'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'smart-overflow') {
      this.handleSmartOverflowChange(newValue);
    }
  }

  get smartOverflow() {
    return this.getAttribute('smart-overflow') || 'off';
  }

  set smartOverflow(value) {
    this.setAttribute('smart-overflow', value);
  }

  handleSmartOverflowChange(value) {
    const smartOverflowMode = value || 'off';
    
    if (smartOverflowMode === 'on') {
      // Enable smart overflow management
      this.enableSmartOverflow();
    } else {
      // Use standard flex layout (default behavior)
      this.enableFlexLayout();
    }
  }

  enableFlexLayout() {
    // Stop observing resize
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    
    // Show all hidden widgets
    this.hiddenWidgets.forEach(widget => {
      widget.removeAttribute('data-overflow-hidden');
    });
    this.hiddenWidgets.clear();
    
    // Hide overflow container
    if (this.overflowContainer) {
      this.overflowContainer.setAttribute('data-overflow-hidden', '');
    }
    
    // Apply flex layout with proper width constraints
    this.style.cssText += `
      height: 50px !important;
      font-size: small !important;
      display: flex !important;
      flex-direction: row !important;
      align-items: center !important;
      gap: 5px !important;
      flex-shrink: 0 !important;
      overflow: hidden !important;
      width: 100% !important;
      box-sizing: border-box !important;
    `;
    
    // Apply flex styles directly to elements since CSS ::slotted might not work
    const inputElements = this.querySelectorAll('sl-select, sl-input, sl-textarea, input, textarea');
    inputElements.forEach(element => {
      element.style.flex = '1 1 auto';
      element.style.minWidth = '80px';
      element.style.width = 'auto';
    });
    
    const fixedElements = this.querySelectorAll('sl-button, button, sl-button-group, sl-icon-button, sl-badge, sl-switch');
    fixedElements.forEach(element => {
      element.style.flex = '0 0 auto';
    });
  }

  enableSmartOverflow() {
    // Re-enable resize observer
    if (this.resizeObserver) {
      this.resizeObserver.observe(this);
    } else {
      this.setupOverflowDetection();
    }
    
    // Reset styles to default component behavior (remove all flex layout overrides)
    this.style.cssText = this.style.cssText.replace(/height: 50px !important;/, '');
    this.style.cssText = this.style.cssText.replace(/font-size: small !important;/, '');
    this.style.cssText = this.style.cssText.replace(/display: flex !important;/, '');
    this.style.cssText = this.style.cssText.replace(/flex-direction: row !important;/, '');
    this.style.cssText = this.style.cssText.replace(/align-items: center !important;/, '');
    this.style.cssText = this.style.cssText.replace(/gap: 5px !important;/, '');
    this.style.cssText = this.style.cssText.replace(/flex-shrink: 0 !important;/, '');
    this.style.cssText = this.style.cssText.replace(/overflow: hidden !important;/, '');
    this.style.cssText = this.style.cssText.replace(/width: 100% !important;/, '');
    this.style.cssText = this.style.cssText.replace(/box-sizing: border-box !important;/, '');
    
    // Ensure all widgets are visible and unhidden before re-checking overflow
    this.hiddenWidgets.forEach(widget => {
      widget.removeAttribute('data-overflow-hidden');
    });
    this.hiddenWidgets.clear();
    
    // Remove flex styles that were applied in flex mode
    const allElements = this.querySelectorAll('sl-select, sl-input, sl-textarea, input, textarea, sl-button, button, sl-button-group, sl-icon-button, sl-badge, sl-switch');
    allElements.forEach(element => {
      element.style.flex = '';
      element.style.minWidth = '';
      element.style.width = '';
    });
    
    // Hide overflow container initially
    if (this.overflowContainer) {
      this.overflowContainer.setAttribute('data-overflow-hidden', '');
    }
    
    // Re-check overflow with a longer delay to ensure layout is settled
    setTimeout(() => {
      // Debug: log the dimensions before overflow check
      const containerRect = this.getBoundingClientRect();
      console.log('Smart overflow check:', {
        containerWidth: containerRect.width,
        widgets: this.getAllWidgetsWithPriority().length
      });
      this.checkAndResolveOverflow();
    }, 300);
  }

  connectedCallback() {
    super.connectedCallback();
    
    // Apply the default behavior after plugins have added their widgets
    setTimeout(() => {
      // Trigger initialization with default value using the proper flow
      const smartOverflowMode = this.getAttribute('smart-overflow') || 'off';
      console.log('ToolBar initializing with smart-overflow:', smartOverflowMode);
      this.handleSmartOverflowChange(smartOverflowMode);
    }, 100);
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
        
        /* In flex mode, allow natural flex behavior */
        :host([smart-overflow="off"]) ::slotted(*) {
          flex-shrink: 1;
        }
        
        /* Make input-type elements flexible in flex mode */
        :host([smart-overflow="off"]) ::slotted(sl-select),
        :host([smart-overflow="off"]) ::slotted(sl-input),
        :host([smart-overflow="off"]) ::slotted(sl-textarea),
        :host([smart-overflow="off"]) ::slotted(input),
        :host([smart-overflow="off"]) ::slotted(textarea) {
          flex: 1 1 auto !important;
          min-width: 80px !important;
          width: auto !important;
        }
        
        /* Keep control elements fixed size in flex mode */
        :host([smart-overflow="off"]) ::slotted(sl-button),
        :host([smart-overflow="off"]) ::slotted(button),
        :host([smart-overflow="off"]) ::slotted(sl-button-group),
        :host([smart-overflow="off"]) ::slotted(sl-icon-button),
        :host([smart-overflow="off"]) ::slotted(sl-badge),
        :host([smart-overflow="off"]) ::slotted(sl-switch) {
          flex: 0 0 auto;
        }
        
        /* Allow dropdowns to size naturally based on content */
        :host([smart-overflow="off"]) ::slotted(sl-select)::part(listbox) {
          width: max-content !important;
          min-width: 200px !important;
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

    // Separate buttons from other complex widgets
    const hiddenButtons = [];
    const hiddenComplexWidgets = [];
    
    hiddenWidgets.forEach(widget => {
      // Whitelist of elements that can go into overflow dropdown
      const canOverflow = ['SL-BUTTON', 'BUTTON'].includes(widget.element.tagName);
      
      if (canOverflow) {
        hiddenButtons.push(widget);
      } else {
        // Everything else (selects, button groups, divs, etc.) is just hidden
        hiddenComplexWidgets.push(widget);
      }
    });
    
    // Create menu items only for simple buttons
    hiddenButtons.forEach(widget => {
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
    
    // Show overflow dropdown only if there are hidden buttons
    if (hiddenButtons.length === 0) {
      this.overflowContainer.setAttribute('data-overflow-hidden', '');
    }
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
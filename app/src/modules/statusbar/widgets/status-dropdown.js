/**
 * Dropdown widget for the status bar
 * Compact dropdown menu with customizable options using Shoelace components
 */

class StatusDropdown extends HTMLElement {
  static get observedAttributes() {
    return ['text', 'selected', 'placeholder', 'disabled', 'variant'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.items = [];
    this.render();
  }

  async connectedCallback() {
    // Ensure Shoelace components are defined before rendering
    await Promise.all([
      customElements.whenDefined('sl-dropdown'),
      customElements.whenDefined('sl-menu'),
      customElements.whenDefined('sl-menu-item')
    ]);
    
    this.render();
    this.parseItems();
    this.setupEventListeners();
  }

  attributeChangedCallback() {
    this.render();
  }

  parseItems() {
    // Parse items from child option elements
    const optionElements = this.querySelectorAll('option');
    if (optionElements.length > 0) {
      this.items = Array.from(optionElements).map(option => ({
        value: option.value || option.textContent,
        text: option.textContent,
        disabled: option.hasAttribute('disabled'),
        selected: option.hasAttribute('selected')
      }));
    }
  }

  setupEventListeners() {
    const dropdown = this.shadowRoot?.querySelector('sl-dropdown');
    if (dropdown) {
      dropdown.addEventListener('sl-select', (e) => {
        this.selectItem(e.detail.item.value);
      });
      
      dropdown.addEventListener('sl-show', () => {
        console.log('Dropdown opened');
      });
      
      dropdown.addEventListener('sl-hide', () => {
        console.log('Dropdown closed');
      });
    }
  }

  disconnectedCallback() {
    // Cleanup handled automatically
  }

  render() {
    const text = this.getAttribute('text') || '';
    const selected = this.getAttribute('selected') || '';
    const placeholder = this.getAttribute('placeholder') || 'Select...';
    const disabled = this.hasAttribute('disabled');

    const selectedItem = this.items.find(item => item.value === selected);
    const displayText = selectedItem ? selectedItem.text : (text || placeholder);

    // Create menu items HTML
    const menuItems = this.items.map(item => `
      <sl-menu-item value="${item.value}" ${item.disabled ? 'disabled' : ''}>
        ${item.text}
      </sl-menu-item>
    `).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          font-size: var(--sl-font-size-x-small);
        }

        sl-dropdown::part(trigger) {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 6px;
          cursor: pointer;
          user-select: none;
          border-radius: 3px;
          transition: background-color 0.1s ease;
          outline: none;
          background-color: transparent;
          color: var(--sl-color-neutral-600);
          border: none;
          min-height: 18px;
          box-sizing: border-box;
          font-size: var(--sl-font-size-x-small);
        }

        sl-dropdown::part(trigger):hover {
          background-color: var(--sl-color-neutral-100);
        }

        :host([disabled]) sl-dropdown::part(trigger) {
          cursor: not-allowed;
          opacity: 0.5;
          pointer-events: none;
        }

        .trigger-content {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .text {
          white-space: nowrap;
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .icon {
          font-size: 8px;
          transition: transform 0.1s ease;
          user-select: none;
          line-height: 1;
        }

        sl-dropdown[open] .icon {
          transform: rotate(180deg);
        }

        sl-dropdown::part(panel) {
          font-size: var(--sl-font-size-x-small);
          min-width: 120px;
          z-index: 9999;
        }

        sl-menu::part(base) {
          font-size: var(--sl-font-size-x-small);
          padding: 4px 0;
        }

        sl-menu-item::part(base) {
          font-size: var(--sl-font-size-x-small);
          padding: 4px 12px;
          min-height: auto;
        }

        sl-menu-item::part(label) {
          font-size: var(--sl-font-size-x-small);
          line-height: 1.2;
        }
      </style>
      
      <sl-dropdown ${disabled ? 'disabled' : ''} hoist distance="4" skidding="0">
        <div slot="trigger" class="trigger-content">
          <span class="text">${displayText}</span>
          <span class="icon">▼</span>
        </div>
        <sl-menu>
          ${menuItems}
        </sl-menu>
      </sl-dropdown>
    `;
  }

  selectItem(value) {
    const item = this.items.find(i => i.value === value);
    if (!item || item.disabled) return;

    this.selected = value;

    this.dispatchEvent(new CustomEvent('widget-change', {
      bubbles: true,
      detail: {
        value: value,
        text: item.text,
        widget: this
      }
    }));
  }

  get text() {
    return this.getAttribute('text') || '';
  }

  set text(value) {
    if (value) {
      this.setAttribute('text', value);
    } else {
      this.removeAttribute('text');
    }
  }

  get selected() {
    return this.getAttribute('selected') || '';
  }

  set selected(value) {
    if (value) {
      this.setAttribute('selected', value);
    } else {
      this.removeAttribute('selected');
    }
  }

  get placeholder() {
    return this.getAttribute('placeholder') || 'Select...';
  }

  set placeholder(value) {
    this.setAttribute('placeholder', value);
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(value) {
    if (value) {
      this.setAttribute('disabled', '');
    } else {
      this.removeAttribute('disabled');
    }
  }

  /**
   * Set dropdown items programmatically
   * @param {Array} items - Array of {value, text, disabled?, selected?} objects
   */
  setItems(items) {
    this.items = items || [];
    this.render();
  }

  /**
   * Add a new item to the dropdown
   * @param {Object} item - {value, text, disabled?, selected?}
   */
  addItem(item) {
    this.items.push(item);
    this.render();
  }

  /**
   * Remove an item from the dropdown
   * @param {string} value - Value of the item to remove
   */
  removeItem(value) {
    this.items = this.items.filter(item => item.value !== value);
    this.render();
  }

  /**
   * Clear all items
   */
  clearItems() {
    this.items = [];
    this.render();
  }
}

customElements.define('status-dropdown', StatusDropdown);

export { StatusDropdown };
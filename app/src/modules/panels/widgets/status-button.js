/**
 * Button widget for the status bar
 * Clickable button with icon and/or text
 */

class StatusButton extends HTMLElement {
  static get observedAttributes() {
    return ['text', 'icon', 'tooltip', 'action', 'variant', 'disabled'];
  }

  constructor() {
    super();
    try {
      this.attachShadow({ mode: 'open' });
      this.render();
    } catch (error) {
      console.error('StatusButton constructor failed:', error);
      // Fallback: create without shadow DOM
      this.innerHTML = '<span>Button (fallback)</span>';
    }
  }

  connectedCallback() {
    this.render();
    this.updateHostProperties();
    this.setupEventListeners();
  }

  attributeChangedCallback() {
    this.render();
    if (this.isConnected) {
      this.updateHostProperties();
    }
  }

  setupEventListeners() {
    this.addEventListener('click', this.handleClick.bind(this));
    this.addEventListener('keydown', this.handleKeydown.bind(this));
  }

  render() {
    if (!this.shadowRoot) {
      console.warn('StatusButton: No shadow root available, skipping render');
      return;
    }
    
    const text = this.getAttribute('text') || '';
    const icon = this.getAttribute('icon') || '';
    const tooltip = this.getAttribute('tooltip') || '';
    const disabled = this.hasAttribute('disabled');
    const variant = this.getAttribute('variant') || 'default';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 6px;
          cursor: pointer;
          user-select: none;
          border-radius: 3px;
          transition: background-color 0.1s ease;
          outline: none;
          border: none;
          background-color: transparent;
          color: var(--sl-color-neutral-600);
          font-size: var(--sl-font-size-x-small);
          min-height: 18px;
          box-sizing: border-box;
        }

        :host(:hover) {
          background-color: var(--sl-color-neutral-100);
        }

        :host(:active) {
          background-color: var(--sl-color-neutral-200);
        }

        :host(:focus-visible) {
          outline: 1px solid var(--sl-color-primary-500);
          outline-offset: 1px;
        }

        :host([disabled]) {
          cursor: not-allowed;
          opacity: 0.5;
          pointer-events: none;
        }

        :host([variant="primary"]) {
          background-color: var(--sl-color-primary-600);
          color: var(--sl-color-neutral-0);
        }

        :host([variant="primary"]:hover) {
          background-color: var(--sl-color-primary-700);
        }

        :host([variant="success"]) {
          color: var(--sl-color-success-600);
        }

        :host([variant="success"]:hover) {
          background-color: var(--sl-color-success-50);
        }

        :host([variant="warning"]) {
          color: var(--sl-color-warning-600);
        }

        :host([variant="warning"]:hover) {
          background-color: var(--sl-color-warning-50);
        }

        :host([variant="danger"]) {
          color: var(--sl-color-danger-600);
        }

        :host([variant="danger"]:hover) {
          background-color: var(--sl-color-danger-50);
        }

        .icon {
          display: inline-flex;
          align-items: center;
          font-size: 12px;
        }

        button {
          border: none;
          background: none;
          padding: 0;
          margin: 0;
          font: inherit;
          color: inherit;
          cursor: inherit;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          outline: none;
        }

        .text {
          white-space: nowrap;
        }

        :host([icon-only]) .text {
          display: none;
        }

        :host([text-only]) .icon {
          display: none;
        }
      </style>
      
      <button tabindex="-1" ${disabled ? 'disabled' : ''}>
        ${icon ? `<sl-icon class="icon" name="${icon}"></sl-icon>` : ''}
        ${text ? `<span class="text">${text}</span>` : ''}
      </button>
    `;
  }

  updateHostProperties() {
    const tooltip = this.getAttribute('tooltip') || '';
    const disabled = this.hasAttribute('disabled');

    if (tooltip) {
      this.title = tooltip;
    }

    // Make the host element focusable
    try {
      this.tabIndex = disabled ? -1 : 0;
    } catch (e) {
      // Some browsers/situations don't allow setting tabIndex
      console.warn('Could not set tabIndex on status-button:', e.message);
    }
  }

  handleClick(event) {
    event.preventDefault();
    if (this.disabled) return;

    const action = this.getAttribute('action') || 'click';
    
    this.dispatchEvent(new CustomEvent('widget-click', {
      bubbles: true,
      detail: {
        action: action,
        widget: this,
        text: this.text,
        icon: this.icon
      }
    }));
  }

  handleKeydown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handleClick(event);
    }
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

  get icon() {
    return this.getAttribute('icon') || '';
  }

  set icon(value) {
    if (value) {
      this.setAttribute('icon', value);
    } else {
      this.removeAttribute('icon');
    }
  }

  get tooltip() {
    return this.getAttribute('tooltip') || '';
  }

  set tooltip(value) {
    if (value) {
      this.setAttribute('tooltip', value);
    } else {
      this.removeAttribute('tooltip');
    }
  }

  get action() {
    return this.getAttribute('action') || 'click';
  }

  set action(value) {
    this.setAttribute('action', value);
  }

  get variant() {
    return this.getAttribute('variant') || 'default';
  }

  set variant(value) {
    if (value && value !== 'default') {
      this.setAttribute('variant', value);
    } else {
      this.removeAttribute('variant');
    }
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
}

customElements.define('status-button', StatusButton);

export { StatusButton };
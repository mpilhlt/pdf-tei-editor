/**
 * Simple text widget for the status bar
 * Displays text with optional icon and tooltip
 */

class StatusText extends HTMLElement {
  static get observedAttributes() {
    return ['text', 'icon', 'tooltip'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.render();
  }

  connectedCallback() {
    this.render();
    this.updateHostProperties();
  }

  attributeChangedCallback() {
    this.render();
    if (this.isConnected) {
      this.updateHostProperties();
    }
  }

  render() {
    const text = this.getAttribute('text') || '';
    const icon = this.getAttribute('icon') || '';
    const tooltip = this.getAttribute('tooltip') || '';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0 4px;
          cursor: default;
          user-select: none;
        }

        .icon {
          display: inline-flex;
          align-items: center;
          font-size: 12px;
        }

        .text {
          font-size: var(--sl-font-size-x-small);
          color: var(--sl-color-neutral-600);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 200px;
        }

        :host([clickable]) {
          cursor: pointer;
          border-radius: var(--sl-border-radius-small);
          transition: background-color 0.1s ease;
        }

        :host([clickable]:hover) {
          background-color: var(--sl-color-neutral-100);
        }

        :host([variant="error"]) .text {
          color: var(--sl-color-danger-600);
        }

        :host([variant="warning"]) .text {
          color: var(--sl-color-warning-600);
        }

        :host([variant="success"]) .text {
          color: var(--sl-color-success-600);
        }
      </style>
      
      ${icon ? `<sl-icon class="icon" name="${icon}"></sl-icon>` : ''}
      <span class="text">${text}</span>
    `;
  }

  updateHostProperties() {
    const tooltip = this.getAttribute('tooltip') || '';
    if (tooltip) {
      this.title = tooltip;
    }
  }

  get text() {
    return this.getAttribute('text') || '';
  }

  set text(value) {
    this.setAttribute('text', value);
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

  get clickable() {
    return this.hasAttribute('clickable');
  }

  set clickable(value) {
    if (value) {
      this.setAttribute('clickable', '');
      this.addEventListener('click', this.handleClick.bind(this));
    } else {
      this.removeAttribute('clickable');
      this.removeEventListener('click', this.handleClick);
    }
  }

  handleClick(event) {
    this.dispatchEvent(new CustomEvent('widget-click', {
      bubbles: true,
      detail: {
        action: 'click',
        widget: this,
        text: this.text
      }
    }));
  }
}

customElements.define('status-text', StatusText);

export { StatusText };
/**
 * Switch widget for the status bar
 * Small switch control with optional help text positioned to the right
 */

class StatusSwitch extends HTMLElement {
  static get observedAttributes() {
    return ['checked', 'disabled', 'text', 'help-text', 'size'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.render();
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
    const switchElement = this.shadowRoot?.querySelector('sl-switch');
    if (switchElement) {
      switchElement.addEventListener('sl-change', (e) => {
        this.checked = e.target.checked;
        
        this.dispatchEvent(new CustomEvent('widget-change', {
          bubbles: true,
          detail: {
            checked: e.target.checked,
            widget: this
          }
        }));
      });
    }
  }

  render() {
    const checked = this.hasAttribute('checked');
    const disabled = this.hasAttribute('disabled');
    const text = this.getAttribute('text') || '';
    const helpText = this.getAttribute('help-text') || '';
    const size = this.getAttribute('size') || 'small';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 2px 4px;
          font-size: var(--sl-font-size-x-small);
          user-select: none;
        }

        .switch-container {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        sl-switch {
          --height: 14px;
          --width: 24px;
          --thumb-size: 10px;
        }

        sl-switch::part(control) {
          border: 1px solid var(--sl-color-neutral-300);
        }

        sl-switch::part(thumb) {
          border: 1px solid var(--sl-color-neutral-300);
        }

        .text {
          font-size: var(--sl-font-size-x-small);
          color: var(--sl-color-neutral-600);
          white-space: nowrap;
        }

        .help-text {
          font-size: var(--sl-font-size-2x-small);
          color: var(--sl-color-neutral-500);
          white-space: nowrap;
          margin-left: 4px;
        }

        :host([disabled]) {
          opacity: 0.5;
          pointer-events: none;
        }
      </style>
      
      <div class="switch-container">
        ${text ? `<span class="text">${text}</span>` : ''}
        <sl-switch 
          size="${size}" 
          ${checked ? 'checked' : ''} 
          ${disabled ? 'disabled' : ''}
        ></sl-switch>
        ${helpText ? `<span class="help-text">${helpText}</span>` : ''}
      </div>
    `;
  }

  updateHostProperties() {
    // No specific host properties needed for switch
  }

  get checked() {
    return this.hasAttribute('checked');
  }

  set checked(value) {
    if (value) {
      this.setAttribute('checked', '');
    } else {
      this.removeAttribute('checked');
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

  get helpText() {
    return this.getAttribute('help-text') || '';
  }

  set helpText(value) {
    if (value) {
      this.setAttribute('help-text', value);
    } else {
      this.removeAttribute('help-text');
    }
  }

  get size() {
    return this.getAttribute('size') || 'small';
  }

  set size(value) {
    this.setAttribute('size', value);
  }
}

customElements.define('status-switch', StatusSwitch);

export { StatusSwitch };
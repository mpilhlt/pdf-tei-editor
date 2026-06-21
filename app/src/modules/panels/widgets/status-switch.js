/**
 * Switch widget for the status bar
 * Small switch control with optional help text positioned to the right
 */

class StatusSwitch extends HTMLElement {
  static get observedAttributes() {
    return ['checked', 'disabled', 'text', 'text-after', 'help-text', 'size'];
  }

  constructor() {
    super();
    this._programmaticChecked = false;
    this.attachShadow({ mode: 'open' });
    this.render();
  }

  connectedCallback() {
    this.render();
    this.updateHostProperties();
    this.setupEventListeners();
  }

  attributeChangedCallback(name) {
    // Skip re-render for programmatic checked changes; the setter updates sl-switch directly.
    if (name === 'checked' && this._programmaticChecked) return;
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
    const textAfter = this.getAttribute('text-after') || '';
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

        :host([hidden]) {
          display: none !important;
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

        .text-after {
          margin-left: -4px;
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
        ${textAfter ? `<span class="text text-after">${textAfter}</span>` : ''}
        ${helpText ? `<span class="help-text">${helpText}</span>` : ''}
      </div>
    `;
    
    // Re-establish event listeners after render since innerHTML wipes them out
    this.setupEventListeners();
  }

  updateHostProperties() {
    // No specific host properties needed for switch
  }

  get checked() {
    return this.hasAttribute('checked');
  }

  set checked(value) {
    // Use flag so attributeChangedCallback skips render; update the inner sl-switch directly
    // to avoid destroying/recreating it, which causes spurious sl-change events from Shoelace.
    this._programmaticChecked = true;
    if (value) {
      this.setAttribute('checked', '');
    } else {
      this.removeAttribute('checked');
    }
    this._programmaticChecked = false;
    const slSwitch = this.shadowRoot?.querySelector('sl-switch');
    if (slSwitch) slSwitch.checked = Boolean(value);
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

  get textAfter() {
    return this.getAttribute('text-after') || '';
  }

  set textAfter(value) {
    if (value) {
      this.setAttribute('text-after', value);
    } else {
      this.removeAttribute('text-after');
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
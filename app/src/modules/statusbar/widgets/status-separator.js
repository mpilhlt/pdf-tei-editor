/**
 * Separator widget for the status bar
 * Visual separator between status bar widgets
 */

class StatusSeparator extends HTMLElement {
  static get observedAttributes() {
    return ['variant', 'spacing'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.render();
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  render() {
    const variant = this.getAttribute('variant') || 'vertical';
    const spacing = this.getAttribute('spacing') || 'normal';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          user-select: none;
          flex-shrink: 0;
        }

        :host([variant="vertical"]) {
          width: 1px;
          height: 12px;
          margin: 0;
        }

        :host([variant="horizontal"]) {
          height: 1px;
          width: 12px;
          margin: 0;
        }

        :host([spacing="tight"]) {
          margin: 0 2px;
        }

        :host([spacing="normal"]) {
          margin: 0 4px;
        }

        :host([spacing="loose"]) {
          margin: 0 8px;
        }

        .separator {
          background-color: var(--sl-color-neutral-300);
          width: 100%;
          height: 100%;
          border-radius: 1px;
        }

        :host([variant="dotted"]) .separator {
          background: none;
          position: relative;
        }

        :host([variant="dotted"]) .separator::after {
          content: '•';
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: var(--sl-color-neutral-400);
          font-size: 8px;
          line-height: 1;
        }

        :host([variant="space"]) .separator {
          background: none;
          width: 8px;
          height: 1px;
        }

        :host([variant="space"][spacing="tight"]) .separator {
          width: 4px;
        }

        :host([variant="space"][spacing="loose"]) .separator {
          width: 12px;
        }

        @media (max-width: 480px) {
          :host([hide-mobile]) {
            display: none;
          }
          
          :host([spacing="normal"]) {
            margin: 0 2px;
          }
          
          :host([spacing="loose"]) {
            margin: 0 4px;
          }
        }
      </style>
      
      <div class="separator"></div>
    `;
  }

  get variant() {
    return this.getAttribute('variant') || 'vertical';
  }

  set variant(value) {
    const validVariants = ['vertical', 'horizontal', 'dotted', 'space'];
    if (validVariants.includes(value)) {
      this.setAttribute('variant', value);
    } else {
      this.removeAttribute('variant');
    }
  }

  get spacing() {
    return this.getAttribute('spacing') || 'normal';
  }

  set spacing(value) {
    const validSpacing = ['tight', 'normal', 'loose'];
    if (validSpacing.includes(value)) {
      this.setAttribute('spacing', value);
    } else {
      this.removeAttribute('spacing');
    }
  }

  get hideMobile() {
    return this.hasAttribute('hide-mobile');
  }

  set hideMobile(value) {
    if (value) {
      this.setAttribute('hide-mobile', '');
    } else {
      this.removeAttribute('hide-mobile');
    }
  }
}

customElements.define('status-separator', StatusSeparator);

export { StatusSeparator };
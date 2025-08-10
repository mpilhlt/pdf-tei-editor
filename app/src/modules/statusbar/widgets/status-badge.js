/**
 * Badge widget for the status bar
 * Shows notification badge with count and variant styling
 */

class StatusBadge extends HTMLElement {
  static get observedAttributes() {
    return ['count', 'text', 'variant', 'icon', 'max', 'tooltip', 'dot', 'pulse', 'clickable', 'hidden-when-zero'];
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
    this.addEventListener('click', this.handleClick.bind(this));
  }

  render() {
    const count = parseInt(this.getAttribute('count')) || 0;
    const text = this.getAttribute('text') || '';
    const variant = this.getAttribute('variant') || 'default';
    const icon = this.getAttribute('icon') || '';
    const max = parseInt(this.getAttribute('max')) || 99;
    const tooltip = this.getAttribute('tooltip') || '';

    const displayCount = count > max ? `${max}+` : count.toString();
    const showBadge = count > 0 || text;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0 4px;
          cursor: ${this.hasAttribute('clickable') ? 'pointer' : 'default'};
          user-select: none;
          border-radius: var(--sl-border-radius-small);
          transition: background-color 0.1s ease;
        }

        :host([clickable]:hover) {
          background-color: var(--sl-color-neutral-100);
        }

        .container {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          position: relative;
        }

        .icon {
          display: inline-flex;
          align-items: center;
          font-size: 12px;
          color: var(--sl-color-neutral-600);
        }

        .badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 16px;
          height: 14px;
          padding: 0 4px;
          border-radius: 7px;
          font-size: 10px;
          font-weight: 600;
          line-height: 1;
          color: var(--sl-color-neutral-0);
          background-color: var(--sl-color-neutral-500);
          white-space: nowrap;
        }

        :host([variant="primary"]) .badge {
          background-color: var(--sl-color-primary-600);
        }

        :host([variant="success"]) .badge {
          background-color: var(--sl-color-success-600);
        }

        :host([variant="warning"]) .badge {
          background-color: var(--sl-color-warning-600);
        }

        :host([variant="danger"]) .badge {
          background-color: var(--sl-color-danger-600);
        }

        :host([variant="info"]) .badge {
          background-color: var(--sl-color-sky-600);
        }

        .badge.dot {
          min-width: 8px;
          width: 8px;
          height: 8px;
          padding: 0;
          border-radius: 50%;
        }

        .badge.pulse {
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0% {
            box-shadow: 0 0 0 0 currentColor;
            opacity: 1;
          }
          70% {
            box-shadow: 0 0 0 4px transparent;
            opacity: 0.7;
          }
          100% {
            box-shadow: 0 0 0 0 transparent;
            opacity: 1;
          }
        }

        :host([hidden-when-zero]) {
          display: ${count === 0 && !text ? 'none' : 'inline-flex'};
        }
      </style>
      
      <div class="container">
        ${icon ? `<sl-icon class="icon" name="${icon}"></sl-icon>` : ''}
        ${showBadge ? `
          <span class="badge ${this.hasAttribute('dot') ? 'dot' : ''} ${this.hasAttribute('pulse') ? 'pulse' : ''}">
            ${this.hasAttribute('dot') ? '' : (text || displayCount)}
          </span>
        ` : ''}
      </div>
    `;
  }

  updateHostProperties() {
    const tooltip = this.getAttribute('tooltip') || '';
    if (tooltip) {
      this.title = tooltip;
    }
  }

  handleClick(event) {
    if (!this.hasAttribute('clickable')) return;

    this.dispatchEvent(new CustomEvent('widget-click', {
      bubbles: true,
      detail: {
        action: 'click',
        widget: this,
        count: this.count,
        text: this.text
      }
    }));
  }

  get count() {
    return parseInt(this.getAttribute('count')) || 0;
  }

  set count(value) {
    this.setAttribute('count', Math.max(0, parseInt(value) || 0).toString());
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

  get max() {
    return parseInt(this.getAttribute('max')) || 99;
  }

  set max(value) {
    this.setAttribute('max', Math.max(0, parseInt(value) || 99).toString());
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

  get clickable() {
    return this.hasAttribute('clickable');
  }

  set clickable(value) {
    if (value) {
      this.setAttribute('clickable', '');
    } else {
      this.removeAttribute('clickable');
    }
  }

  get dot() {
    return this.hasAttribute('dot');
  }

  set dot(value) {
    if (value) {
      this.setAttribute('dot', '');
    } else {
      this.removeAttribute('dot');
    }
  }

  get pulse() {
    return this.hasAttribute('pulse');
  }

  set pulse(value) {
    if (value) {
      this.setAttribute('pulse', '');
    } else {
      this.removeAttribute('pulse');
    }
  }

  get hiddenWhenZero() {
    return this.hasAttribute('hidden-when-zero');
  }

  set hiddenWhenZero(value) {
    if (value) {
      this.setAttribute('hidden-when-zero', '');
    } else {
      this.removeAttribute('hidden-when-zero');
    }
  }

  /**
   * Increment the badge count
   * @param {number} amount - Amount to increment by (default: 1)
   */
  increment(amount = 1) {
    this.count += amount;
  }

  /**
   * Decrement the badge count
   * @param {number} amount - Amount to decrement by (default: 1)
   */
  decrement(amount = 1) {
    this.count = Math.max(0, this.count - amount);
  }

  /**
   * Reset the badge count to 0
   */
  reset() {
    this.count = 0;
  }
}

customElements.define('status-badge', StatusBadge);

export { StatusBadge };
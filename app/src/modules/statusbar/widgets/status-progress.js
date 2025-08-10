/**
 * Progress widget for the status bar
 * Shows progress bar with optional text
 */

class StatusProgress extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'max', 'text', 'indeterminate', 'variant'];
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
    const value = parseFloat(this.getAttribute('value')) || 0;
    const max = parseFloat(this.getAttribute('max')) || 100;
    const text = this.getAttribute('text') || '';
    const indeterminate = this.hasAttribute('indeterminate');
    const variant = this.getAttribute('variant') || 'default';
    
    const percentage = indeterminate ? 0 : Math.min(100, Math.max(0, (value / max) * 100));

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 0 4px;
          min-width: 80px;
          max-width: 150px;
        }

        .progress-container {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 1;
        }

        .progress-bar {
          flex: 1;
          height: 4px;
          background-color: var(--sl-color-neutral-200);
          border-radius: 2px;
          overflow: hidden;
          position: relative;
        }

        .progress-fill {
          height: 100%;
          background-color: var(--sl-color-primary-500);
          border-radius: 2px;
          transition: width 0.3s ease;
          width: ${percentage}%;
        }

        :host([variant="success"]) .progress-fill {
          background-color: var(--sl-color-success-500);
        }

        :host([variant="warning"]) .progress-fill {
          background-color: var(--sl-color-warning-500);
        }

        :host([variant="danger"]) .progress-fill {
          background-color: var(--sl-color-danger-500);
        }

        :host([indeterminate]) .progress-fill {
          width: 30%;
          animation: indeterminate 2s infinite linear;
        }

        @keyframes indeterminate {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(333%);
          }
        }

        .text {
          font-size: var(--sl-font-size-x-small);
          color: var(--sl-color-neutral-600);
          white-space: nowrap;
          min-width: 0;
          flex-shrink: 0;
        }

        .percentage {
          font-size: var(--sl-font-size-x-small);
          color: var(--sl-color-neutral-500);
          min-width: 30px;
          text-align: right;
        }

        :host([hide-percentage]) .percentage {
          display: none;
        }

        :host([indeterminate]) .percentage {
          display: none;
        }
      </style>
      
      <div class="progress-container">
        ${text ? `<span class="text">${text}</span>` : ''}
        <div class="progress-bar">
          <div class="progress-fill"></div>
        </div>
        <span class="percentage">${Math.round(percentage)}%</span>
      </div>
    `;
  }

  get value() {
    return parseFloat(this.getAttribute('value')) || 0;
  }

  set value(val) {
    this.setAttribute('value', val.toString());
  }

  get max() {
    return parseFloat(this.getAttribute('max')) || 100;
  }

  set max(val) {
    this.setAttribute('max', val.toString());
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

  get indeterminate() {
    return this.hasAttribute('indeterminate');
  }

  set indeterminate(value) {
    if (value) {
      this.setAttribute('indeterminate', '');
    } else {
      this.removeAttribute('indeterminate');
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

  get hidePercentage() {
    return this.hasAttribute('hide-percentage');
  }

  set hidePercentage(value) {
    if (value) {
      this.setAttribute('hide-percentage', '');
    } else {
      this.removeAttribute('hide-percentage');
    }
  }

  /**
   * Update progress value with optional animation
   * @param {number} value - New value
   * @param {boolean} animate - Whether to animate the change
   */
  updateProgress(value, animate = true) {
    if (!animate) {
      this.style.setProperty('--transition-duration', '0s');
    }
    this.value = value;
    if (!animate) {
      // Reset transition after a frame
      requestAnimationFrame(() => {
        this.style.removeProperty('--transition-duration');
      });
    }
  }

  /**
   * Reset progress to 0
   */
  reset() {
    this.value = 0;
    this.indeterminate = false;
  }

  /**
   * Complete progress (set to max value)
   */
  complete() {
    this.indeterminate = false;
    this.value = this.max;
  }
}

customElements.define('status-progress', StatusProgress);

export { StatusProgress };
/**
 * Icon-only toggle button widget for toolbars and status bars.
 *
 * Extends {@link StatusButton}. Clicking (or Enter/Space) toggles the `checked`
 * attribute and dispatches a bubbling `widget-change` event with
 * `detail: { checked, value, widget }`. The tooltip is rendered with `sl-tooltip`
 * instead of the native `title` attribute.
 *
 * Two appearances, selected via the `appearance` attribute:
 * - `"toolbar"` (default) — bordered "filled pill": off = neutral chrome,
 *   `checked` = primary fill, `disabled` = faded with a diagonal hatch overlay
 *   that keeps disabled-on and disabled-off distinct. Use this for a standalone
 *   prominent toggle.
 * - `"flat"` — compact, borderless, sized to match plain `<status-button>`
 *   siblings: off = transparent/ghost (matches StatusButton's default chrome),
 *   `checked` = primary fill. Use this when the toggle sits among plain flat
 *   status-bar/toolbar buttons and should match their footprint.
 *
 * Group styling: an element with class `status-toggle-group` lays out its
 * children (typically a `status-toggle-button` next to a `status-button`) with
 * a small gap, for widgets that belong together but don't need a fused/
 * bordered look — both members should use the flat appearance so their
 * chrome stays consistent with the rest of the toolbar.
 */

import { StatusButton } from './status-button.js';

class StatusToggleButton extends StatusButton {
  /** @returns {string[]} Observed attributes of {@link StatusButton} plus `checked` and `appearance` */
  static get observedAttributes() {
    return [...super.observedAttributes, 'checked', 'appearance'];
  }

  /**
   * Registers click and keydown listeners once. Overrides the parent implementation,
   * which would add duplicate listeners (and thus toggle twice) every time the element
   * is re-attached to the DOM.
   * @returns {void}
   */
  setupEventListeners() {
    if (this._listenersAttached) return;
    this._listenersAttached = true;
    this.addEventListener('click', this.handleClick.bind(this));
    this.addEventListener('keydown', this.handleKeydown.bind(this));
  }

  /**
   * Renders the shadow DOM: an `sl-tooltip` wrapping the icon button.
   * @returns {void}
   */
  render() {
    if (!this.shadowRoot) {
      console.warn('StatusToggleButton: No shadow root available, skipping render');
      return;
    }

    const icon = this.getAttribute('icon') || '';
    const tooltip = this.getAttribute('tooltip') || '';
    const disabled = this.hasAttribute('disabled');
    const escapedTooltip = tooltip.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 2px 6px;
          cursor: pointer;
          user-select: none;
          border: 1px solid var(--sl-color-neutral-300);
          border-radius: 3px;
          background-color: var(--sl-color-neutral-0);
          color: var(--sl-color-neutral-600);
          font-size: var(--sl-font-size-small);
          min-height: 24px;
          min-width: 28px;
          box-sizing: border-box;
          outline: none;
          transition: background-color 0.1s ease, color 0.1s ease;
        }

        :host(:hover) {
          background-color: var(--sl-color-neutral-100);
        }

        :host(:focus-visible) {
          outline: 1px solid var(--sl-color-primary-500);
          outline-offset: 1px;
          position: relative;
          z-index: 1;
        }

        :host([checked]) {
          background-color: var(--sl-color-primary-600);
          border-color: var(--sl-color-primary-600);
          color: var(--sl-color-neutral-0);
        }

        :host([checked]:hover) {
          background-color: var(--sl-color-primary-700);
          border-color: var(--sl-color-primary-700);
        }

        :host([disabled]) {
          cursor: not-allowed;
          opacity: 0.5;
          filter: saturate(0.4);
          background-image: repeating-linear-gradient(45deg, transparent 0, transparent 3px, rgba(128, 128, 128, 0.35) 3px, rgba(128, 128, 128, 0.35) 4px);
        }

        :host([disabled]:not([checked]):hover) {
          background-color: var(--sl-color-neutral-0);
        }

        :host([disabled][checked]:hover) {
          background-color: var(--sl-color-primary-600);
          border-color: var(--sl-color-primary-600);
        }

        /* Flat appearance: borderless, sized like plain status-button siblings.
           On/off is still unambiguous (transparent vs. solid fill), but disabled
           falls back to plain opacity (like status-button) rather than the hatch
           overlay, since a hatch pattern floating over a transparent background
           reads as a stray visual artifact rather than a disabled control. */
        :host([appearance="flat"]) {
          padding: 2px 6px;
          border: none;
          border-radius: 3px;
          background-color: transparent;
          color: var(--sl-color-neutral-600);
          font-size: var(--sl-font-size-x-small);
          min-height: 18px;
          min-width: 0;
        }

        :host([appearance="flat"]:hover) {
          background-color: var(--sl-color-neutral-100);
        }

        :host([appearance="flat"][checked]) {
          background-color: var(--sl-color-primary-600);
          color: var(--sl-color-neutral-0);
        }

        :host([appearance="flat"][checked]:hover) {
          background-color: var(--sl-color-primary-700);
        }

        :host([appearance="flat"][disabled]) {
          cursor: not-allowed;
          opacity: 0.5;
          filter: none;
          background-image: none;
          pointer-events: none;
        }

        :host([appearance="flat"][checked][disabled]) {
          background-color: var(--sl-color-primary-600);
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
          outline: none;
        }

        .icon {
          display: inline-flex;
          align-items: center;
          font-size: 14px;
        }

        :host([appearance="flat"]) .icon {
          font-size: 12px;
        }
      </style>

      <sl-tooltip content="${escapedTooltip}" ${tooltip ? '' : 'disabled'}>
        <button tabindex="-1" ${disabled ? 'disabled' : ''}>
          ${icon ? `<sl-icon class="icon" name="${icon}"></sl-icon>` : ''}
        </button>
      </sl-tooltip>
    `;
  }

  /**
   * Syncs host accessibility properties. Unlike the parent, does not set the native
   * `title` (the tooltip is rendered by `sl-tooltip`).
   * @returns {void}
   */
  updateHostProperties() {
    const disabled = this.hasAttribute('disabled');

    this.setAttribute('role', 'button');
    this.setAttribute('aria-pressed', this.checked ? 'true' : 'false');
    this.setAttribute('aria-disabled', disabled ? 'true' : 'false');

    try {
      this.tabIndex = disabled ? -1 : 0;
    } catch (e) {
      console.warn('Could not set tabIndex on status-toggle-button:', e.message);
    }
  }

  /**
   * Toggles the `checked` state and dispatches `widget-change`. Does nothing when disabled.
   * @param {Event} event - The click or keydown event
   * @returns {void}
   */
  handleClick(event) {
    event.preventDefault();
    if (this.disabled) return;

    this.checked = !this.checked;

    this.dispatchEvent(new CustomEvent('widget-change', {
      bubbles: true,
      detail: {
        checked: this.checked,
        value: this.checked,
        widget: this
      }
    }));
  }

  /** @returns {boolean} Whether the toggle is on */
  get checked() {
    return this.hasAttribute('checked');
  }

  /** @param {boolean} value - Whether the toggle is on (does not dispatch `widget-change`) */
  set checked(value) {
    if (value) {
      this.setAttribute('checked', '');
    } else {
      this.removeAttribute('checked');
    }
  }
}

customElements.define('status-toggle-button', StatusToggleButton);

export { StatusToggleButton };

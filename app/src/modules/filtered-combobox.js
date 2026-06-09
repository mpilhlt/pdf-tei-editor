/**
 * Filtered combobox web component.
 *
 * A single input field that shows a filtered, scrollable dropdown of options as the user types.
 * Built on Shoelace sl-popup + sl-menu + sl-menu-item primitives.
 * Emits `sl-change` (matching Shoelace conventions) with `{ value, label }` in `event.detail`.
 */

/**
 * @typedef {object} ComboboxOption
 * @property {string} value - Value emitted on selection
 * @property {string} label - Primary display text (used for filtering)
 * @property {string} [secondary] - Secondary text shown in the dropdown (also filtered)
 * @property {string} [group] - Group header label; options with the same group are grouped together
 */

export class FilteredCombobox extends HTMLElement {
  static observedAttributes = ['placeholder', 'size', 'disabled']

  #options = []
  #value = null
  #label = null
  #popup = null
  #input = null
  #menu = null

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        sl-popup::part(popup) {
          z-index: var(--sl-z-index-dropdown, 900);
          background: var(--sl-color-neutral-0, #fff);
          border: 1px solid var(--sl-color-neutral-200, #e4e4e7);
          border-radius: var(--sl-border-radius-medium, 4px);
          box-shadow: var(--sl-shadow-large, 0 8px 24px rgba(0,0,0,.12));
          overflow: hidden;
        }
        sl-menu {
          max-height: min(220px, 40vh);
          overflow-y: auto;
          padding: 4px 0;
          border: none;
          box-shadow: none;
          border-radius: 0;
        }
      </style>
      <sl-popup placement="bottom-start" sync="width" flip shift strategy="fixed" distance="4">
        <sl-input slot="anchor" clearable></sl-input>
        <sl-menu></sl-menu>
      </sl-popup>
    `

    this.#popup = this.shadowRoot.querySelector('sl-popup')
    this.#input = this.shadowRoot.querySelector('sl-input')
    this.#menu = this.shadowRoot.querySelector('sl-menu')

    const placeholder = this.getAttribute('placeholder')
    if (placeholder) this.#input.placeholder = placeholder
    const size = this.getAttribute('size')
    if (size) this.#input.size = size
    if (this.hasAttribute('disabled')) this.#input.disabled = true

    this.#input.addEventListener('sl-input', () => {
      this.#value = null
      this.#label = null
      this.#renderItems(this.#input.value || '')
    })

    this.#input.addEventListener('sl-focus', () => {
      this.#renderItems(this.#input.value || '')
    })

    this.#input.addEventListener('sl-clear', () => {
      this.#value = null
      this.#label = null
      this.#closePopup()
    })

    this.#input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && this.#popup.active) {
        e.preventDefault()
        const first = this.#menu.querySelector('sl-menu-item:not([disabled])')
        first?.focus()
      }
      if (e.key === 'Escape') this.#closePopup()
    })

    this.#menu.addEventListener('sl-select', (e) => {
      const item = e.detail.item
      this.#select(String(item.value), item.dataset.label || item.textContent.trim())
      e.stopPropagation()
    })

    document.addEventListener('mousedown', this.#onOutsideMouseDown, true)

    this.#renderItems()
  }

  disconnectedCallback() {
    document.removeEventListener('mousedown', this.#onOutsideMouseDown, true)
  }

  attributeChangedCallback(name, _old, val) {
    if (!this.#input) return
    if (name === 'placeholder') this.#input.placeholder = val || ''
    if (name === 'size') this.#input.size = val || 'medium'
    if (name === 'disabled') this.#input.disabled = this.hasAttribute('disabled')
  }

  #onOutsideMouseDown = (e) => {
    if (!e.composedPath().includes(this)) this.#closePopup()
  }

  #openPopup() {
    if (this.#popup) this.#popup.active = true
  }

  #closePopup() {
    if (this.#popup) this.#popup.active = false
  }

  #select(value, label) {
    this.#value = value
    this.#label = label
    if (this.#input) this.#input.value = label
    this.#closePopup()
    this.dispatchEvent(new CustomEvent('sl-change', {
      detail: { value, label },
      bubbles: true,
      composed: true
    }))
  }

  #renderItems(filter = '') {
    if (!this.#menu) return
    this.#menu.innerHTML = ''
    const lc = filter.toLowerCase()
    let currentGroup = null
    let visibleCount = 0

    for (const opt of this.#options) {
      const matchLabel = opt.label.toLowerCase().includes(lc)
      const matchSecondary = (opt.secondary || '').toLowerCase().includes(lc)
      if (filter && !matchLabel && !matchSecondary) continue
      visibleCount++

      if (opt.group !== undefined && opt.group !== currentGroup) {
        currentGroup = opt.group
        if (this.#menu.children.length > 0) {
          this.#menu.appendChild(document.createElement('sl-divider'))
        }
        const groupHeader = document.createElement('sl-menu-item')
        groupHeader.setAttribute('disabled', '')
        groupHeader.style.cssText = 'font-size: 0.75em; font-weight: 600; color: var(--sl-color-neutral-600); letter-spacing: 0.04em; text-transform: uppercase;'
        groupHeader.textContent = opt.group
        this.#menu.appendChild(groupHeader)
      }

      const item = document.createElement('sl-menu-item')
      item.value = opt.value
      item.dataset.label = opt.label
      item.textContent = opt.label
      if (opt.secondary) {
        const suffix = document.createElement('span')
        suffix.slot = 'suffix'
        suffix.style.cssText = 'font-size: 0.8em; color: var(--sl-color-neutral-500);'
        suffix.textContent = opt.secondary
        item.appendChild(suffix)
      }
      this.#menu.appendChild(item)
    }

    if (visibleCount > 0) this.#openPopup()
    else this.#closePopup()
  }

  /**
   * Replace the available options in the dropdown.
   * @param {ComboboxOption[]} options
   */
  setOptions(options) {
    this.#options = [...options]
    if (this.#menu) this.#renderItems(this.#input?.value || '')
  }

  /** @returns {string | null} The selected value, or null if nothing is selected. */
  get value() {
    return this.#value
  }

  /** @returns {string | null} The display label of the selected item. */
  get selectedLabel() {
    return this.#label
  }

  /** Clear the input text and reset the selected value. */
  clear() {
    this.#value = null
    this.#label = null
    if (this.#input) this.#input.value = ''
    this.#closePopup()
  }
}

if (typeof customElements !== 'undefined') {
  customElements.define('filtered-combobox', FilteredCombobox)
}

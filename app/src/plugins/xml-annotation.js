/**
 * The XML Annotation plugin.
 *
 * Adds a visual annotation mode to the XML editor: hides raw XML markup and
 * replaces it with coloured inline badges. Depends on the xmleditor plugin
 * for the CodeMirror extension slot API, and on the extraction plugin for
 * per-variant annotation tag definitions.
 *
 * @import { ApplicationState } from '../state.js'
 */

import Plugin from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { PanelUtils } from '../modules/panels/index.js'
import { XmlAnnotationPopup } from '../modules/codemirror/xml-annotation-popup.js'

/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null,
 *   color: string, attributes: Array<{name:string, values?: string[]|null}> }} AnnotationTagDef
 */

class XmlAnnotationPlugin extends Plugin {
  static extensionPoints = [ep.xmlEditor.contextMenuItems];

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Called by XmlEditorPlugin.start() to collect context menu contributions.
   * Delegates to {@link XmlAnnotationPlugin#contextMenuItems}.
   * @returns {Array<{element: HTMLElement, onBeforeShow?: () => void}>}
   */
  [ep.xmlEditor.contextMenuItems]() { return this.#contextMenuItems() }

  constructor(context) {
    super(context, { name: 'xml-annotation', deps: ['xmleditor', 'extraction', 'logger'] })
  }

  get #logger()    { return this.getDependency('logger') }
  get #extraction(){ return this.getDependency('extraction') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {{ reconfigure: (ext: any) => void }|null} */
  #slot = null;

  /** @type {AnnotationTagDef[]} */
  #tagDefs = [];

  /** @type {boolean} */
  #annotationMode = false;

  /** @type {boolean} */
  #wasReadOnlyBeforeAnnotation = false;

  /** @type {any} */
  #switch = null;

  /** @type {HTMLElement[]} */
  #menuTagItems = [];

  /** @type {HTMLElement|null} */
  #menuDivider = null;

  /** @type {HTMLElement|null} */
  #menuRemoveItem = null;

  /** @type {XmlAnnotationPopup|null} */
  #popup = null;

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    this.#logger.debug('Installing plugin "xml-annotation"')

    // Claim a compartment slot in the live CM editor
    this.#slot = this.#xmlEditor.createExtensionSlot([])

    // Build the statusbar switch
    this.#switch = PanelUtils.createSwitch({
      name: 'annotationModeSwitch',
      text: 'Annotate',
      disabled: true,
      helpText: 'No annotation tags defined for this variant'
    })
    this.#switch.addEventListener('widget-change', () => this.#onSwitchChange())
    this.uiStorage.bind(this.#switch, 'checked', { key: 'annotationMode', event: 'widget-change', default: false })
    this.#xmlEditor.addStatusbarWidget(this.#switch, 'left', 90)

    // Mount the properties popup
    const editorContainer = document.getElementById('codemirror-container')
    if (editorContainer) {
      this.#popup = new XmlAnnotationPopup(this.#xmlEditor)
      this.#popup.mount(editorContainer, this.#tagDefs)
    }
  }

  // ── Context menu contribution ───────────────────────────────────────

  /**
   * Returns annotation context menu items: divider + remove item + one item per tag.
   * Items are hidden when annotation mode is OFF (managed in onBeforeShow callbacks).
   * @returns {Array<{element: HTMLElement, onBeforeShow?: () => void}>}
   */
  #contextMenuItems() {
    const divider = document.createElement('sl-divider')
    divider.hidden = true
    this.#menuDivider = divider

    const removeItem = document.createElement('sl-menu-item')
    removeItem.textContent = 'Remove annotation'
    removeItem.hidden = true
    removeItem.disabled = true
    this.#menuRemoveItem = removeItem
    removeItem.addEventListener('click', () => this.#removeAnnotationAtClick())

    const items = [
      {
        element: divider,
        onBeforeShow: () => { divider.hidden = !this.#annotationMode }
      },
      {
        element: removeItem,
        onBeforeShow: () => {
          removeItem.hidden = !this.#annotationMode
          if (!this.#annotationMode) return
          const view = this.#xmlEditor.getView?.()
          const synced = this.#xmlEditor.isSynced?.()
          if (!view || !synced) { removeItem.disabled = true; return }
          try {
            const el = /** @type {Element|null} */ (this.#xmlEditor.getDomNodeAt?.(view.state.selection.main.head))
            removeItem.disabled = !el || !this.#tagDefs.some(d => d.tag === el.localName)
          } catch { removeItem.disabled = true }
        }
      }
    ]

    for (const def of this.#tagDefs) {
      const item = document.createElement('sl-menu-item')
      item.textContent = def.label.replace(/\{@[^}]+\}/g, '…')
      item.dataset.tag = def.tag
      item.hidden = true
      item.disabled = true
      item.addEventListener('click', () => this.#wrapSelectionWith(def))
      items.push({
        element: item,
        onBeforeShow: () => {
          item.hidden = !this.#annotationMode
          if (!this.#annotationMode) return
          const view = this.#xmlEditor.getView?.()
          const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 }
          item.disabled = !view || !this.#xmlEditor.isSynced?.() || from === to
        }
      })
      this.#menuTagItems.push(item)
    }

    return items
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async #onSwitchChange() {
    if (this.#switch?.checked) {
      await this.#enableAnnotationMode()
    } else {
      await this.#disableAnnotationMode()
    }
  }

  // ── Stubs (implemented in Tasks 6 and 7) ───────────────────────────

  async #enableAnnotationMode() { /* Task 6 */ }
  async #disableAnnotationMode() { /* Task 6 */ }
  async #wrapSelectionWith(_def) { /* Task 7 */ }
  async #removeAnnotationAtClick() { /* Task 7 */ }

  /**
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) { /* Task 8 */ }
}

export default XmlAnnotationPlugin

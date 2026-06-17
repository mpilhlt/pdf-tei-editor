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
import { XMLEditor } from '../modules/xmleditor.js'
import ui from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import { createAnnotationField, annotationTheme } from '../modules/codemirror/xml-annotation-decorations.js'

/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null,
 *   color: string, attributes: Array<{name:string, values?: string[]|null}>,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null }} AnnotationTagDef
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

  /** @type {HTMLElement|null} */
  #menuSentinel = null;

  /** @type {number|null} */
  #topLevelCount = null;

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

    // Rebuild decorations and scroll when a new document is loaded in annotation mode
    this.#xmlEditor.on(XMLEditor.EVENT_EDITOR_AFTER_LOAD, () => this.#onDocumentLoaded())

    // Populate tag defs from initialState so the popup tagMap is ready before any variant change fires
    if (initialState.variant) {
      await this.#updateTagDefs(initialState)
    }
  }

  // ── Context menu contribution ───────────────────────────────────────

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Called by XmlEditorPlugin.start() to collect context menu contributions.
   * Delegates to {@link XmlAnnotationPlugin#contextMenuItems}.
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

    const sentinel = document.createElement('sl-divider')
    sentinel.hidden = true
    this.#menuSentinel = sentinel

    return [
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
      },
      {
        element: sentinel,
        onBeforeShow: () => this.#rebuildTagMenuItems()
      }
    ]
  }

  /**
   * Rebuilds tag menu items in the context menu each time it opens.
   * Called via the sentinel element's onBeforeShow callback.
   */
  #rebuildTagMenuItems() {
    const menu = this.#menuSentinel?.parentElement
    if (!menu) return
    for (const item of this.#menuTagItems) item.remove()
    this.#menuTagItems = []
    if (!this.#annotationMode || this.#tagDefs.length === 0) return
    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    const cutoff = this.#topLevelCount
    const topDefs = cutoff != null ? sorted.slice(0, cutoff) : sorted
    const moreDefs = cutoff != null ? sorted.slice(cutoff) : []
    const view = this.#xmlEditor.getView?.()
    const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 }
    const hasSelection = from !== to && !!this.#xmlEditor.isSynced?.()
    for (const def of topDefs) {
      const item = this.#createTagItem(def, hasSelection)
      menu.insertBefore(item, this.#menuSentinel)
      this.#menuTagItems.push(item)
    }
    if (moreDefs.length > 0) {
      const submenu = this.#createTagSubmenu(moreDefs, hasSelection)
      menu.insertBefore(submenu, this.#menuSentinel)
      this.#menuTagItems.push(submenu)
    }
  }

  /**
   * Creates a single tag menu item for the context menu.
   * @param {AnnotationTagDef} def
   * @param {boolean} hasSelection
   * @returns {HTMLElement}
   */
  #createTagItem(def, hasSelection) {
    const item = document.createElement('sl-menu-item')
    item.textContent = def.label.replace(/\{@[^}]+\}/g, '…')
    item.dataset.tag = def.tag
    item.disabled = !hasSelection
    if (def.description) item.title = def.description
    item.addEventListener('click', () => this.#wrapSelectionWith(def))
    return item
  }

  /**
   * Creates a "More…" submenu containing the lower-priority tag items.
   * @param {AnnotationTagDef[]} defs
   * @param {boolean} hasSelection
   * @returns {HTMLElement}
   */
  #createTagSubmenu(defs, hasSelection) {
    const wrapper = document.createElement('sl-menu-item')
    wrapper.textContent = 'More…'
    const inner = document.createElement('sl-menu')
    inner.slot = 'submenu'
    for (const def of defs) inner.appendChild(this.#createTagItem(def, hasSelection))
    wrapper.appendChild(inner)
    return wrapper
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async #onSwitchChange() {
    if (this.#switch?.checked) {
      await this.#enableAnnotationMode()
    } else {
      await this.#disableAnnotationMode()
    }
  }

  async #enableAnnotationMode() {
    if (!this.#xmlEditor.getXmlTree || !this.#xmlEditor.getXmlTree()) {
      notify('Cannot enable annotation mode: XML is not well-formed', 'warning', 'exclamation-triangle')
      if (this.#switch) this.#switch.checked = false
      return
    }
    const xmlTree = this.#xmlEditor.getXmlTree()
    const textEl = xmlTree?.querySelector('text')
    if (!textEl) {
      notify('Cannot enable annotation mode: no <text> element found', 'warning', 'exclamation-triangle')
      if (this.#switch) this.#switch.checked = false
      return
    }
    this.#annotationMode = true
    this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])
    this.#wasReadOnlyBeforeAnnotation = this.#xmlEditor.isReadOnly?.() ?? false
    if (!this.#wasReadOnlyBeforeAnnotation) {
      await this.#xmlEditor.setReadOnly?.(true)
    }
    ui.xmlEditor.headerbar.hidden = true
    this.#setContextMenuItemsVisible(true)
    this.#scrollToTextElement()
  }

  async #disableAnnotationMode() {
    this.#annotationMode = false
    this.#slot?.reconfigure([])
    if (!this.#wasReadOnlyBeforeAnnotation) {
      await this.#xmlEditor.setReadOnly?.(false)
    }
    ui.xmlEditor.headerbar.hidden = false
    this.#setContextMenuItemsVisible(false)
    if (this.#switch && this.#switch.checked) this.#switch.checked = false
  }

  /** @param {boolean} visible */
  #setContextMenuItemsVisible(visible) {
    if (this.#menuDivider) this.#menuDivider.hidden = !visible
    if (this.#menuRemoveItem) this.#menuRemoveItem.hidden = !visible
  }

  async #onDocumentLoaded() {
    if (!this.#annotationMode) return
    if (this.#tagDefs.length === 0) {
      await this.#disableAnnotationMode()
      return
    }
    // Rebuild decorations for the newly loaded document
    this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])
    this.#scrollToTextElement()
  }

  #scrollToTextElement() {
    const xmlTree = this.#xmlEditor.getXmlTree?.()
    if (!xmlTree) return
    const textEl = xmlTree.querySelector('text')
    if (!textEl) return
    try {
      const pos = this.#xmlEditor.getDomNodePosition?.(textEl)
      if (pos != null) {
        this.#xmlEditor.getView?.()?.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      }
    } catch (e) {
      // CM view may not be ready if the editor has not rendered yet; scroll is optional UI polish
      this.#logger.debug('[xml-annotation] scroll to text element failed: ' + String(e))
    }
  }

  /**
   * Wraps the current CM selection in the given annotation tag and re-syncs.
   * @param {AnnotationTagDef} def
   */
  async #wrapSelectionWith(def) {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const { from, to } = view.state.selection.main
    if (from === to) return
    const selectedText = view.state.doc.sliceString(from, to)
    const attrStr = def.defaultAttributes
      ? ' ' + Object.entries(def.defaultAttributes).map(([k, v]) => `${k}="${v}"`).join(' ')
      : ''
    const wrapped = `<${def.tag}${attrStr}>${selectedText}</${def.tag}>`
    view.dispatch({ changes: { from, to, insert: wrapped }, userEvent: 'input.annotate' })
    try {
      const ancestor = this.#xmlEditor.getDomNodeAt?.(from)
      if (ancestor) await this.#xmlEditor.updateEditorFromNode?.(ancestor.parentNode ?? ancestor)
    } catch (e) {
      this.#logger.debug('[xml-annotation] wrap sync failed: ' + String(e))
    }
  }

  /**
   * Removes the annotation element at the cursor position by unwrapping its children to the parent.
   */
  async #removeAnnotationAtClick() {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const pos = view.state.selection.main.head
    try {
      const node = this.#xmlEditor.getDomNodeAt?.(pos)
      if (!(node instanceof Element)) return
      if (!this.#tagDefs.some(d => d.tag === node.localName)) return
      const parent = node.parentNode
      if (!parent) return
      while (node.firstChild) parent.insertBefore(node.firstChild, node)
      parent.removeChild(node)
      await this.#xmlEditor.updateEditorFromNode?.(parent)
    } catch (err) {
      // Annotation removal can fail if the XML DOM is out of sync; log as warning since this
      // represents an unexpected state (unlike wrap-sync failures which are timing-related)
      this.#logger.warn('[xml-annotation] remove annotation failed: ' + String(err))
    }
  }

  /**
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    if (changedKeys.includes('variant')) {
      await this.#updateTagDefs(state)
    }
    if (changedKeys.includes('xml') && !state.xml && this.#annotationMode) {
      await this.#disableAnnotationMode()
    }
  }

  /** @param {ApplicationState} state */
  async #updateTagDefs(state) {
    const variant = state.variant
    const extractors = this.#extraction.extractorInfo()
    /** @type {AnnotationTagDef[]} */
    const newDefs = []
    this.#topLevelCount = null

    if (extractors && variant) {
      for (const ext of extractors) {
        if (!ext.variants || ext.variants.includes(variant)) {
          const variantTags = /** @type {any} */ (ext).annotationTags?.[variant]
          if (Array.isArray(variantTags)) newDefs.push(...variantTags)
          const cutoff = /** @type {any} */ (ext).annotationTagsCutoff?.[variant]
          if (cutoff != null) this.#topLevelCount = cutoff
        }
      }
    }

    this.#tagDefs = newDefs
    const hasTagDefs = newDefs.length > 0

    if (this.#switch) {
      this.#switch.hidden = !hasTagDefs
      this.#switch.helpText = hasTagDefs ? '' : 'No annotation tags defined for this variant'
    }

    this.#popup?.updateTagDefs(newDefs)

    if (this.#annotationMode) {
      if (!hasTagDefs) {
        await this.#disableAnnotationMode()
      } else {
        this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])
      }
    }
  }
}

export default XmlAnnotationPlugin

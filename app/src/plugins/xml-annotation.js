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

  /** @type {boolean} */
  #wasHeaderVisible = false;

  /** @type {any} */
  #switch = null;

  /** @type {HTMLElement|null} */
  #menuDivider = null;

  /** @type {HTMLElement|null} */
  #menuRemoveItem = null;

  /** @type {HTMLElement|null} */
  #paletteDiv = null;

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
      text: 'XML',
      helpText: 'No annotation tags defined for this variant'
    })
    this.#switch.setAttribute('text-after', 'Visual')
    this.#switch.hidden = true
    this.#switch.addEventListener('widget-change', () => {
      this.dispatchStateChange({ view: this.#switch.checked ? 'annotation' : null })
    })
    this.#xmlEditor.addStatusbarWidget(this.#switch, 'left', 3)

    // Mount the properties popup
    const editorContainer = document.getElementById('codemirror-container')
    if (editorContainer) {
      this.#popup = new XmlAnnotationPopup(this.#xmlEditor)
      this.#popup.mount(editorContainer, this.#tagDefs)
    }

    // Rebuild decorations and scroll when a new document is loaded in annotation mode
    this.#xmlEditor.on(XMLEditor.EVENT_EDITOR_AFTER_LOAD, () => this.#onDocumentLoaded())

    // Populate tag defs from initialState so the popup tagMap is ready before any variant change fires.
    // Skip if not authenticated yet — onStateUpdate will populate after login.
    if (initialState.variant && initialState.user) {
      await this.#updateTagDefs(initialState)
    }
  }

  // ── Context menu contribution ───────────────────────────────────────

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Returns a section divider, a "Remove annotation" item, and a tag palette
   * div whose chips are rebuilt each time the menu opens via onBeforeShow.
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

    const palette = document.createElement('div')
    palette.hidden = true
    Object.assign(palette.style, {
      display: 'flex', flexWrap: 'wrap', gap: '4px',
      padding: '4px 12px 8px', boxSizing: 'border-box', maxWidth: '260px'
    })
    this.#paletteDiv = palette

    return [
      {
        element: divider,
        prepend: true,
        onBeforeShow: () => { divider.hidden = !this.#annotationMode }
      },
      {
        element: removeItem,
        prepend: true,
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
        element: palette,
        prepend: true,
        onBeforeShow: () => this.#rebuildPalette()
      }
    ]
  }

  /** Rebuilds the tag chip palette each time the context menu opens. */
  #rebuildPalette() {
    const palette = this.#paletteDiv
    if (!palette) return
    palette.hidden = !this.#annotationMode
    palette.replaceChildren()
    if (!this.#annotationMode || this.#tagDefs.length === 0) return

    const view = this.#xmlEditor.getView?.()
    const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 }
    const hasSelection = from !== to && !!this.#xmlEditor.isSynced?.()

    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    for (const def of sorted) {
      const chip = document.createElement('span')
      chip.textContent = def.label.replace(/\{@[^}]+\}/g, '…')
      chip.title = def.description || def.label
      chip.dataset.tag = def.tag
      Object.assign(chip.style, {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: '3px',
        padding: '2px 6px 3px',
        cursor: hasSelection ? 'pointer' : 'not-allowed',
        opacity: hasSelection ? '1' : '0.35',
        userSelect: 'none',
      })
      if (hasSelection) {
        chip.addEventListener('click', () => this.#wrapSelectionWith(def))
      }
      palette.appendChild(chip)
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async #enableAnnotationMode() {
    const xmlTree = this.#xmlEditor.getXmlTree?.()
    if (!xmlTree) {
      // No document loaded yet; #onDocumentLoaded will retry once the editor is ready
      return
    }
    const textEl = xmlTree.querySelector('text')
    if (!textEl) {
      notify('Cannot enable annotation mode: no <text> element found', 'warning', 'exclamation-triangle')
      this.scheduleStateChange({ view: null })
      return
    }
    this.#annotationMode = true
    if (this.#switch) this.#switch.checked = true
    this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])
    this.#wasReadOnlyBeforeAnnotation = this.#xmlEditor.isReadOnly?.() ?? false
    if (!this.#wasReadOnlyBeforeAnnotation) {
      await this.#xmlEditor.setReadOnly?.(true)
    }
    // Always collapse the TEI header in annotation mode; restore on exit
    const headerToggle = /** @type {any} */ (ui.xmlEditor.toolbar.teiHeaderToggleWidget)
    this.#wasHeaderVisible = headerToggle.checked ?? false
    await this.#xmlEditor.foldByXpath?.('//tei:teiHeader')
    headerToggle.checked = false
    ui.xmlEditor.headerbar.hidden = true
    ui.xmlEditor.toolbar.lineWrappingSwitch.disabled = true
    ui.xmlEditor.toolbar.teiHeaderToggleWidget.disabled = true
    this.#setContextMenuItemsVisible(true)
    this.#scrollToTextElement()
  }

  async #disableAnnotationMode() {
    this.#annotationMode = false
    if (this.#switch) this.#switch.checked = false
    this.#slot?.reconfigure([])
    if (!this.#wasReadOnlyBeforeAnnotation) {
      await this.#xmlEditor.setReadOnly?.(false)
    }
    ui.xmlEditor.headerbar.hidden = false
    ui.xmlEditor.toolbar.lineWrappingSwitch.disabled = false
    ui.xmlEditor.toolbar.teiHeaderToggleWidget.disabled = false
    // Restore TEI header to its pre-annotation visibility
    if (this.#wasHeaderVisible) {
      await this.#xmlEditor.unfoldByXpath?.('//tei:teiHeader')
      const headerToggle = /** @type {any} */ (ui.xmlEditor.toolbar.teiHeaderToggleWidget)
      headerToggle.checked = true
    }
    this.#setContextMenuItemsVisible(false)
    // Revert state if this was triggered internally (e.g. document removed, variant lost tagDefs).
    // Must not be awaited: called from onStateUpdate while propagation is active, so the deferred
    // Promise would deadlock (scheduleStateChange flushes only after propagation ends).
    if (this.state.view === 'annotation') {
      this.scheduleStateChange({ view: null })
    }
  }

  /** @param {boolean} visible */
  #setContextMenuItemsVisible(visible) {
    if (this.#menuDivider) this.#menuDivider.hidden = !visible
    if (this.#menuRemoveItem) this.#menuRemoveItem.hidden = !visible
    if (this.#paletteDiv) this.#paletteDiv.hidden = !visible
  }

  async #onDocumentLoaded() {
    // state.view may have been restored from URL/localStorage before the document was ready;
    // activate annotation mode now that the editor has content.
    if (!this.#annotationMode && this.state.view === 'annotation' && this.#tagDefs.length > 0) {
      await this.#enableAnnotationMode()
      return
    }
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
    if (changedKeys.includes('view')) {
      const wantAnnotation = state.view === 'annotation'
      if (this.#switch) this.#switch.checked = wantAnnotation
      if (wantAnnotation && !this.#annotationMode) {
        await this.#enableAnnotationMode()
      } else if (!wantAnnotation && this.#annotationMode) {
        await this.#disableAnnotationMode()
      }
    }
    // Re-assert disabled state each time state updates while annotation mode is active,
    // because other plugins' onStateUpdate handlers may re-enable these controls.
    if (this.#annotationMode) {
      ui.xmlEditor.toolbar.lineWrappingSwitch.disabled = true
      ui.xmlEditor.toolbar.teiHeaderToggleWidget.disabled = true
    }
  }

  /** @param {ApplicationState} state */
  async #updateTagDefs(state) {
    const variant = state.variant
    let extractors = this.#extraction.extractorInfo()
    if (!extractors) {
      extractors = await this.getDependency('client').getExtractorList()
    }
    /** @type {AnnotationTagDef[]} */
    const newDefs = []

    if (extractors && variant) {
      for (const ext of extractors) {
        if (!ext.variants || ext.variants.includes(variant)) {
          const variantTags = /** @type {any} */ (ext).annotationTags?.[variant]
          if (Array.isArray(variantTags)) newDefs.push(...variantTags)
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
    } else if (hasTagDefs && this.state.view === 'annotation' && this.#xmlEditor.getXmlTree?.()) {
      // tagDefs just became available and the document is already loaded; activate now
      await this.#enableAnnotationMode()
    }
  }
}

export default XmlAnnotationPlugin

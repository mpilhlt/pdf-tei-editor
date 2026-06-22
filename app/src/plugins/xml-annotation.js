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
import { PanelUtils } from '../modules/panels/index.js'
import { XmlAnnotationPopup } from '../modules/codemirror/xml-annotation-popup.js'
import { XMLEditor } from '../modules/xmleditor.js'
import ui from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import { createAnnotationField, annotationTheme, navigateEffect, createNavigationField } from '../modules/codemirror/xml-annotation-decorations.js'
import { findCmScrollContainer, getFirstVisibleCharacter, scrollCharacterToTop } from '../modules/codemirror/codemirror-utils.js'
import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'

/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null,
 *   color: string, attributes?: Array<{name:string, values?: string[]|null}>|null,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null,
 *   childTags?: string[]|null }} AnnotationTagDef
 */

class XmlAnnotationPlugin extends Plugin {
  constructor(context) {
    super(context, { name: 'xml-annotation', deps: ['xmleditor', 'extraction', 'logger'] })
  }

  get #logger()    { return this.getDependency('logger') }
  get #extraction(){ return this.getDependency('extraction') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {{ reconfigure: (ext: any) => void }|null} */
  #slot = null;

  /** Navigation highlight field — created once and reused across all reconfigure() calls so CM
   *  preserves its decoration state when compartment contents change (e.g. tag def updates). */
  #navField = createNavigationField();

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
      this.#popup.setWrapCallback(def => this.#wrapSelectionWith(def))
    }

    // Rebuild decorations and scroll when a new document is loaded in annotation mode
    this.#xmlEditor.on(XMLEditor.EVENT_EDITOR_AFTER_LOAD, () => this.#onDocumentLoaded())

    // Populate tag defs from initialState so the popup tagMap is ready before any variant change fires.
    // Skip if not authenticated yet — onStateUpdate will populate after login.
    if (initialState.variant && initialState.user) {
      await this.#updateTagDefs(initialState)
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
    // Capture character position of first visible line before any layout changes.
    const cmView = this.#xmlEditor.getView?.()
    const scrollContainer = cmView ? findCmScrollContainer(cmView) : null
    const savedPos = cmView && scrollContainer ? getFirstVisibleCharacter(cmView, scrollContainer) : 0

    this.#annotationMode = true
    if (this.#switch) this.#switch.checked = true
    this.#slot?.reconfigure([
      createAnnotationField(this.#tagDefs),
      annotationTheme,
      this.#navField,
      EditorView.domEventHandlers({ mouseup: (e, view) => this.#onEditorMouseUp(e, view) })
    ])
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
    ui.xmlEditor.toolbar.teiHeaderToggleWidget.disabled = true
    // Restore the first visible line after CM has re-rendered in the new mode.
    // Two rAFs ensure CM's own layout update fires before we read lineBlockAt.
    if (cmView && scrollContainer != null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollCharacterToTop(cmView, scrollContainer, savedPos)
        })
      })
    }
  }

  async #disableAnnotationMode() {
    // Capture character position of first visible line before any layout changes.
    const cmView = this.#xmlEditor.getView?.()
    const scrollContainer = cmView ? findCmScrollContainer(cmView) : null
    const savedPos = cmView && scrollContainer ? getFirstVisibleCharacter(cmView, scrollContainer) : 0

    this.#annotationMode = false
    if (this.#switch) this.#switch.checked = false
    this.#slot?.reconfigure([])
    if (!this.#wasReadOnlyBeforeAnnotation) {
      await this.#xmlEditor.setReadOnly?.(false)
    }
    ui.xmlEditor.headerbar.hidden = false
    ui.xmlEditor.toolbar.lineWrappingSwitch.disabled = false
    ui.xmlEditor.toolbar.teiHeaderToggleWidget.disabled = false
    // Restore TEI header to its pre-annotation state (explicit in both branches so toggle
    // always reflects the previously user-selected state, not annotation-mode defaults).
    const headerToggle = /** @type {any} */ (ui.xmlEditor.toolbar.teiHeaderToggleWidget)
    if (this.#wasHeaderVisible) {
      await this.#xmlEditor.unfoldByXpath?.('//tei:teiHeader')
      headerToggle.checked = true
    } else {
      headerToggle.checked = false
    }
    // Revert state if this was triggered internally (e.g. document removed, variant lost tagDefs).
    // Must not be awaited: called from onStateUpdate while propagation is active, so the deferred
    // Promise would deadlock (scheduleStateChange flushes only after propagation ends).
    if (this.state.view === 'annotation') {
      this.scheduleStateChange({ view: null })
    }
    // Restore the first visible line after CM has re-rendered in the new mode.
    // Two rAFs ensure CM's own layout update fires before we read lineBlockAt.
    if (cmView && scrollContainer != null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollCharacterToTop(cmView, scrollContainer, savedPos)
        })
      })
    }
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
    this.#slot?.reconfigure([
      createAnnotationField(this.#tagDefs),
      annotationTheme,
      this.#navField,
      EditorView.domEventHandlers({ mouseup: (e, view) => this.#onEditorMouseUp(e, view) })
    ])
    if (this.state?.xpath) {
      this.#scrollToXpath(this.state.xpath)
    } else {
      this.#scrollToTextElement()
    }
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
   * If the selection falls inside an existing annotation element whose tag does not
   * list `def.tag` in `childTags`, the parent element is split around the selection
   * instead of nesting the new tag inside it.
   * @param {AnnotationTagDef} def
   */
  async #wrapSelectionWith(def) {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const { from, to } = view.state.selection.main
    if (from === to) return

    const enclosing = this.#findEnclosingAnnotation(view.state, from, to)
    if (enclosing) {
      const parentDefs = this.#tagDefs.filter(d => d.tag === enclosing.tagName)
      const isChildTag = parentDefs.some(d => d.childTags?.includes(def.tag))
      if (!isChildTag) {
        await this.#splitAnnotation(view, from, to, def, enclosing)
        return
      }
    }

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
   * Walks the Lezer syntax tree upward from `from` to find the innermost annotation
   * element (tag in `#tagDefs`) that fully contains the range [from, to].
   * @param {import('@codemirror/state').EditorState} state
   * @param {number} from
   * @param {number} to
   * @returns {{ tagName: string, openTagText: string, contentFrom: number, contentTo: number, elementFrom: number, elementTo: number }|null}
   */
  #findEnclosingAnnotation(state, from, to) {
    const tagSet = new Set(this.#tagDefs.map(d => d.tag))
    let node = syntaxTree(state).resolveInner(from, 1)
    while (node) {
      if (node.name === 'Element') {
        const openTag = node.firstChild
        if (openTag?.name === 'OpenTag') {
          const tagNameNode = openTag.firstChild?.nextSibling
          if (tagNameNode?.name === 'TagName') {
            const tagName = state.doc.sliceString(tagNameNode.from, tagNameNode.to)
            if (tagSet.has(tagName)) {
              const closeTag = node.lastChild
              if (closeTag && (closeTag.name === 'CloseTag' || closeTag.name === 'MismatchedCloseTag')) {
                const contentFrom = openTag.to
                const contentTo = closeTag.from
                if (from >= contentFrom && to <= contentTo) {
                  return {
                    tagName,
                    openTagText: state.doc.sliceString(openTag.from, openTag.to),
                    contentFrom,
                    contentTo,
                    elementFrom: node.from,
                    elementTo: node.to,
                  }
                }
              }
            }
          }
        }
      }
      node = node.parent
    }
    return null
  }

  /**
   * Splits the enclosing annotation element around the selection [from, to] and
   * applies `def` to the selected text. The text before and after the selection
   * each become separate elements of the original parent type (preserving its
   * open-tag markup including attributes). Empty before/after parts are omitted.
   * @param {import('@codemirror/view').EditorView} view
   * @param {number} from
   * @param {number} to
   * @param {AnnotationTagDef} def
   * @param {{ tagName: string, openTagText: string, contentFrom: number, contentTo: number, elementFrom: number, elementTo: number }} enclosing
   */
  async #splitAnnotation(view, from, to, def, enclosing) {
    const { tagName, openTagText, contentFrom, contentTo, elementFrom, elementTo } = enclosing
    const state = view.state
    const beforeText = state.doc.sliceString(contentFrom, from)
    const selectedText = state.doc.sliceString(from, to)
    const afterText = state.doc.sliceString(to, contentTo)
    const attrStr = def.defaultAttributes
      ? ' ' + Object.entries(def.defaultAttributes).map(([k, v]) => `${k}="${v}"`).join(' ')
      : ''
    let replacement = ''
    if (beforeText.length > 0) replacement += `${openTagText}${beforeText}</${tagName}>`
    replacement += `<${def.tag}${attrStr}>${selectedText}</${def.tag}>`
    if (afterText.length > 0) replacement += `${openTagText}${afterText}</${tagName}>`
    view.dispatch({ changes: { from: elementFrom, to: elementTo, insert: replacement }, userEvent: 'input.annotate' })
    // sync() rebuilds the DOM from the current CM state (CM→DOM).
    // updateEditorFromNode is intentionally NOT used here: it goes DOM→CM with the stale
    // pre-split DOM, which would revert the split.
    try {
      await this.#xmlEditor.sync?.()
    } catch (e) {
      this.#logger.debug('[xml-annotation] split sync failed: ' + String(e))
    }
  }

  /**
   * Handles mouseup events on the CM editor content in annotation mode.
   * Shows the "Annotate as…" popup when a non-empty selection is present.
   * Skips if the event target is (or is inside) an annotation badge — badge clicks
   * are handled by the ann-badge-click path.
   * @param {MouseEvent} e
   * @param {import('@codemirror/view').EditorView} view
   * @returns {boolean}
   */
  #onEditorMouseUp(e, view) {
    if (!this.#annotationMode) return false
    if (e.target instanceof Element && e.target.closest('.ann-badge')) return false
    // Defer one macrotask: CM commits selection on document mouseup (after this contentDOM
    // mouseup), and the browser fires a click after mouseup which would immediately dismiss
    // the popup via the document click listener. Deferring past both events solves both.
    const coords = { clientX: e.clientX, clientY: e.clientY }
    setTimeout(() => {
      const { from, to } = view.state.selection.main
      if (from === to) return
      this.#popup?.showForSelection(coords, from, to)
    }, 0)
    return false
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
    // In annotation mode, override the range selection that XmlEditorPlugin dispatches for xpath
    // navigation with a cursor at the element start, so the scroll target is reliable and the
    // selection doesn't visually conflict with ann-outer/ann-inner decorations.
    if (changedKeys.includes('xpath') && this.#annotationMode && state.xpath) {
      this.#scrollToXpath(state.xpath)
    }
    // Re-assert teiHeaderToggle disabled state each time state updates while annotation mode is active,
    // because other plugins' onStateUpdate handlers may re-enable these controls.
    if (this.#annotationMode) {
      ui.xmlEditor.toolbar.teiHeaderToggleWidget.disabled = true
    }
  }

  /**
   * Navigates the editor to the element matched by xpath: places the cursor right after the open
   * tag (= after the badge widget), scrolls it into view, and adds an `ann-navigated` border
   * decoration around the element content so the current element is visually distinct.
   *
   * Uses getDomNodesByXpath (ORDERED_NODE_ITERATOR_TYPE) rather than getSyntaxNodeByXpath
   * (which internally uses FIRST_ORDERED_NODE_TYPE) to avoid a Firefox XPath evaluation error
   * where type 9 throws "Result type mismatch" in certain timing contexts.
   * @param {string} xpath
   */
  #scrollToXpath(xpath) {
    try {
      const nodes = this.#xmlEditor.getDomNodesByXpath?.(xpath)
      const domNode = nodes?.[0]
      if (!domNode) return
      const pos = this.#xmlEditor.getDomNodePosition?.(domNode)
      if (pos == null) return
      const syntaxNode = this.#xmlEditor.getSyntaxNodeAt?.(pos)
      if (!syntaxNode) return
      const openTag  = syntaxNode.firstChild
      const closeTag = syntaxNode.lastChild
      // contentFrom: right after the open tag's '>' (= after the badge widget in annotation mode)
      // contentTo:   right before the close tag's '<' (= end of visible content)
      const contentFrom = openTag  ? openTag.to            : syntaxNode.from
      const contentTo   = (closeTag && closeTag !== openTag) ? closeTag.from : syntaxNode.to
      this.#xmlEditor.getView?.()?.dispatch({
        effects: navigateEffect.of({ from: contentFrom, to: contentTo }),
        selection: { anchor: contentFrom },
        scrollIntoView: true
      })
    } catch (e) {
      this.#logger.debug('[xml-annotation] xpath scroll failed: ' + String(e))
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
        this.#slot?.reconfigure([
          createAnnotationField(this.#tagDefs),
          annotationTheme,
          this.#navField,
          EditorView.domEventHandlers({ mouseup: (e, view) => this.#onEditorMouseUp(e, view) })
        ])
      }
    } else if (hasTagDefs && this.state.view === 'annotation' && this.#xmlEditor.getXmlTree?.()) {
      // tagDefs just became available and the document is already loaded; activate now
      await this.#enableAnnotationMode()
    }
  }
}

export default XmlAnnotationPlugin

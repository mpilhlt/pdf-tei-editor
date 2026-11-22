/**
 * Editor Sync Plugin
 *
 * Synchronizes the XML editor and the PDF viewer in both directions while the "Sync with
 * editor" switch, which the plugin contributes to the PDF viewer's statusbar (via
 * `pdfViewer.statusbarItems`), is on:
 *
 * - XML -> PDF: when another node is selected in the XML editor, the PDF region the node was
 *   extracted from is looked up and highlighted. Other plugins request such a lookup via the
 *   `pdfSearch.searchNode` extension point (see ServicesPlugin.searchNodeContentsInPdf()).
 *   Nodes without text, and nodes whose text is not found, are passed to the
 *   `pdfSearch.fallback` handlers. In documents with page breaks (`<pb/>`), the text is first
 *   looked up only on the PDF page that the nearest preceding `<pb/>` points to, and in the
 *   whole PDF only if it is not found there.
 * - PDF -> XML: when the user pages through the PDF (`pdfViewer.pageChanged`), the XML editor
 *   is scrolled to the `<pb/>` of that page, without changing the selection.
 *
 * A `<pb/>` points to a PDF page by its `n` attribute or, if it has none, by its position
 * among all `<pb/>` elements, shifted by the offset learned from earlier matches in the
 * document. Nothing depends on the document's variant.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { RangeWithNode } from '../modules/xmleditor.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { PDFJSViewer } from '../modules/pdfviewer.js'
 * @import { NavXmlEditor } from '../modules/navigatable-xmleditor.js'
 * @import PdfViewerPlugin from './pdfviewer.js'
 * @import { PageBreakHint } from '../modules/tei-utils.js'
 * @import { MatchResult } from '../modules/pdf-text-matcher.js'
 */

/**
 * The API of the pdfviewer plugin (see PdfViewerPlugin.getApi())
 * @typedef {PDFJSViewer & Pick<PdfViewerPlugin, 'showStatusMessage'|'clearStatusMessage'>} PdfViewerApi
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { PanelUtils } from '../modules/panels/index.js'
import { UIStorage } from '../modules/ui-storage.js'
import { isInTeiText, getPageBreakHint, findPageBreak, getPageBreakText, getPdfLookupNode } from '../modules/tei-utils.js'

/** Storage key of the switch state */
const STORAGE_KEY = 'enabled'

/** Minimum length of the text of a page for verifying that a `<pb/>` belongs to a PDF page */
const MIN_VERIFY_TEXT_LENGTH = 20

class EditorSyncPlugin extends Plugin {
  static extensionPoints = [ep.pdfViewer.statusbarItems, ep.pdfViewer.pageChanged, ep.pdfSearch.searchNode];

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'editor-sync',
      deps: ['logger', 'pdfviewer', 'xmleditor']
    })
  }

  get #logger() { return this.getDependency('logger') }
  /** @returns {PdfViewerApi} */
  get #pdfViewer() { return /** @type {PdfViewerApi} */ (/** @type {unknown} */ (this.getDependency('pdfviewer'))) }
  /** @returns {NavXmlEditor} */
  get #xmlEditor() { return /** @type {NavXmlEditor} */ (/** @type {unknown} */ (this.getDependency('xmleditor'))) }

  /** @type {StatusSwitch|null} */
  #switch = null

  /** @type {Node|null} The node looked up last on a selection change */
  #lastNode = null

  /**
   * Offsets between the PDF page of a match and the page break hint of its node, learned
   * from the matches in the current document; null while unknown
   * @type {{n: number|null, ordinal: number|null}}
   */
  #pageOffsets = { n: null, ordinal: null }

  /**
   * Whether the "Sync with editor" switch is on.
   * @returns {boolean}
   */
  isEnabled() {
    return Boolean(/** @type {any} */ (this.#switch)?.checked)
  }

  /**
   * Starts listening to selection changes in the XML editor.
   * @returns {Promise<void>}
   */
  async start() {
    this.#xmlEditor.on('selectionChanged', (/** @type {RangeWithNode[]} */ ranges) => this.#onSelectionChanged(ranges))
  }

  /**
   * Resets the page offsets learned for the previous document.
   * @returns {void}
   */
  onXmlChange() {
    this.#pageOffsets = { n: null, ordinal: null }
  }

  /**
   * Extension point handler for `ep.pdfViewer.statusbarItems`.
   * Called by PdfViewerPlugin.start() to collect the widgets of the PDF viewer's statusbar.
   * Delegates to {@link EditorSyncPlugin#getStatusbarItems}.
   * @returns {Array<{element: HTMLElement, position: 'left', priority: number}>}
   */
  [ep.pdfViewer.statusbarItems]() {
    return this.getStatusbarItems()
  }

  /**
   * Creates the "Sync with editor" switch, restoring its last state.
   * @returns {Array<{element: HTMLElement, position: 'left', priority: number}>}
   */
  getStatusbarItems() {
    const checked = this.#loadEnabled()
    const widget = PanelUtils.createSwitch({
      text: 'Sync with editor',
      helpText: checked ? 'on' : 'off',
      checked,
      name: 'syncSwitch'
    })
    widget.addEventListener('widget-change', (evt) => this.#onSwitchChange(/** @type {CustomEvent} */ (evt)))
    this.#switch = widget
    return [{ element: widget, position: 'left', priority: 10 }]
  }

  /**
   * Extension point handler for `ep.pdfSearch.searchNode`.
   * Called by ServicesPlugin.searchNodeContentsInPdf() to locate a node in the PDF.
   * Delegates to {@link EditorSyncPlugin#searchNode}.
   * @param {Element} node
   * @returns {Promise<void>}
   */
  async [ep.pdfSearch.searchNode](node) {
    return this.searchNode(node)
  }

  /**
   * Given a node in the XML, locates and highlights the region of the PDF
   * it was extracted from, using fuzzy sequence matching on the node's
   * ordered text content. Nodes outside `/TEI/text` (e.g. in the teiHeader)
   * are ignored, since they have no counterpart in the PDF. Nodes without text
   * (e.g. `<pb/>`) and nodes whose text is not found are passed to the
   * `pdfSearch.fallback` handlers.
   * @param {Element} node
   * @returns {Promise<void>}
   */
  async searchNode(node) {
    if (!isInTeiText(node)) {
      return
    }
    const pdfViewer = this.#pdfViewer
    const queryText = getNodeText(node).join(' ')
    if (!queryText.trim()) {
      // Empty elements such as <pb/> have no text to search for, but a
      // pdfSearch.fallback handler may still know their page
      if (await this.#searchFallback(node)) {
        this.#logger.debug('PDF position of an element without text found by a pdfSearch.fallback handler')
        pdfViewer.clearStatusMessage()
      }
      return
    }
    // If the node originates from a footnote, prepend the printed footnote
    // number: the footnote text in the PDF physically starts with it
    const footnoteId = getSourceFootnoteId(node)
    const query = footnoteId ? `${footnoteId} ${queryText}` : queryText
    const match = await this.#search(node, query)
    if (match) {
      this.#logger.debug(`PDF match: page ${match.page}, score ${match.score.toFixed(3)}`)
      pdfViewer.clearStatusMessage()
    } else if (await this.#searchFallback(node)) {
      this.#logger.debug('PDF position found by a pdfSearch.fallback handler')
      pdfViewer.clearStatusMessage()
    } else {
      this.#logger.debug(`No PDF match for query: ${query.slice(0, 80)}...`)
      pdfViewer.showStatusMessage('No sufficiently similar text found in the PDF')
    }
  }

  /**
   * Searches the PDF for the query, first on the pages that the page break hint of the node
   * points to, then on all pages.
   * @param {Element} node - The node the query was taken from
   * @param {string} query
   * @returns {Promise<MatchResult|null>}
   */
  async #search(node, query) {
    const pdfViewer = this.#pdfViewer
    const hint = getPageBreakHint(node)
    if (hint) {
      const pages = this.#candidatePages(hint, pdfViewer.pdfDoc?.numPages ?? 0)
      if (pages.length > 0) {
        const match = await pdfViewer.search(query, { pages })
        if (match) {
          this.#logger.debug(`PDF match on page ${match.page} found via <pb/> hint (pages ${pages.join(', ')})`)
          return match
        }
      }
    }
    const match = await pdfViewer.search(query)
    if (match) {
      this.#learnPageOffsets(node, match.page)
    }
    return match
  }

  /**
   * The PDF pages that a page break hint points to: its `n` and its ordinal, each shifted by
   * the learned offset if there is one, and unshifted.
   * @param {PageBreakHint} hint
   * @param {number} pageCount - Number of pages of the PDF
   * @returns {number[]} Distinct 1-based page numbers within the PDF, most likely first
   */
  #candidatePages(hint, pageCount) {
    const { n: offsetN, ordinal: offsetOrdinal } = this.#pageOffsets
    const pages = [
      hint.n !== null && offsetN !== null ? hint.n + offsetN : null,
      offsetOrdinal !== null ? hint.ordinal + offsetOrdinal : null,
      hint.n,
      hint.ordinal
    ]
    return [...new Set(pages)].filter(p => p !== null && p >= 1 && p <= pageCount)
  }

  /**
   * Records the offsets between the PDF page at which a node was found and the page break
   * hint of the node, for mapping `<pb/>` elements to PDF pages in both directions.
   * @param {Node} node
   * @param {number} page - 1-based PDF page
   * @returns {void}
   */
  #learnPageOffsets(node, page) {
    const hint = getPageBreakHint(node)
    if (hint) {
      this.#pageOffsets = {
        n: hint.n === null ? null : page - hint.n,
        ordinal: page - hint.ordinal
      }
    }
  }

  /**
   * Extension point handler for `ep.pdfViewer.pageChanged`.
   * Called by PdfViewerPlugin when the current page of the PDF viewer has changed.
   * Delegates to {@link EditorSyncPlugin#onPdfPageChanged}.
   * @param {number} page - 1-based page number
   * @param {{userInitiated: boolean}} info
   * @returns {Promise<void>}
   */
  async [ep.pdfViewer.pageChanged](page, info) {
    return this.onPdfPageChanged(page, info)
  }

  /**
   * Scrolls the XML editor to the `<pb/>` of a PDF page that the user navigated to, if the
   * switch is on. Does not change the selection, so that no lookup in the PDF follows.
   * @param {number} page - 1-based page number
   * @param {{userInitiated: boolean}} info
   * @returns {Promise<void>}
   */
  async onPdfPageChanged(page, { userInitiated }) {
    if (!userInitiated || !this.isEnabled()) {
      return
    }
    const doc = this.#xmlEditor.getXmlTree()
    if (!doc) {
      return
    }
    const pb = await this.#findPageBreakForPage(doc, page)
    if (!pb) {
      return
    }
    try {
      this.#xmlEditor.scrollToNode(pb)
    } catch (error) {
      // the editor content may not be in sync with the DOM (e.g. malformed XML)
      this.#logger.debug(`Cannot scroll the XML editor to the page break of page ${page}: ${String(error)}`)
    }
  }

  /**
   * Finds the `<pb/>` of a PDF page. Candidates are the `<pb/>` elements whose `n` or
   * position among all `<pb/>` elements equals the page, shifted by the learned offset if
   * there is one, and unshifted. The first candidate whose page text is found on the PDF page
   * wins. If none can be verified that way (e.g. because the PDF has no text layer), the
   * candidate given by a learned offset is used, if any.
   * @param {Document} doc
   * @param {number} page - 1-based PDF page
   * @returns {Promise<Element|null>}
   */
  async #findPageBreakForPage(doc, page) {
    const { n: offsetN, ordinal: offsetOrdinal } = this.#pageOffsets
    /** @type {Array<{pb: Element|null, learned: boolean}>} */
    const candidates = [
      { pb: offsetN !== null ? findPageBreak(doc, { n: page - offsetN }) : null, learned: true },
      { pb: offsetOrdinal !== null ? findPageBreak(doc, { ordinal: page - offsetOrdinal }) : null, learned: true },
      { pb: findPageBreak(doc, { n: page }), learned: false },
      { pb: findPageBreak(doc, { ordinal: page }), learned: false }
    ]
    /** @type {Set<Element>} */
    const checked = new Set()
    for (const { pb } of candidates) {
      if (!pb || checked.has(pb)) continue
      checked.add(pb)
      const text = getPageBreakText(pb)
      if (text.length >= MIN_VERIFY_TEXT_LENGTH && await this.#pdfViewer.findMatch(text, { pages: [page] })) {
        return pb
      }
    }
    return candidates.find(c => c.learned && c.pb)?.pb ?? null
  }

  /**
   * Asks the `pdfSearch.fallback` handlers of other plugins for the PDF page of a node
   * whose text could not be found in the PDF, and scrolls to the first page returned.
   * @param {Element} node
   * @returns {Promise<boolean>} Whether a page was found
   */
  async #searchFallback(node) {
    const pdfViewer = this.#pdfViewer
    const pageCount = pdfViewer.pdfDoc?.numPages ?? 0
    const results = await this.context.invokePluginEndpoint(
      ep.pdfSearch.fallback, [node, { xml: this.state?.xml ?? null, pageCount }], { result: 'values', throws: false }
    )
    const pages = (Array.isArray(results) ? results : []).map(r => r?.page)
    const page = pages.find(p => Number.isInteger(p) && p >= 1 && p <= pageCount)
    if (!page) {
      return false
    }
    this.#learnPageOffsets(node, page)
    await pdfViewer.goToPage(page)
    return true
  }

  /**
   * Looks up the newly selected node in the PDF if the switch is on.
   * @param {RangeWithNode[]} ranges
   * @returns {Promise<void>}
   */
  async #onSelectionChanged(ranges) {
    // workaround for the node selection not being updated immediately
    await new Promise(resolve => setTimeout(resolve, 100))
    const node = this.#getSearchNode(/** @type {{node?: Element|null}|undefined} */ (ranges?.[0])?.node ?? null)
    if (this.isEnabled() && node && node !== this.#lastNode) {
      // Record the node before awaiting the search: "selectionChanged" can fire
      // several times in quick succession for the same effective selection (e.g.
      // during initial document load), each scheduling this async handler. Without
      // updating #lastNode synchronously here, all of them would still see the stale
      // value while the first search is in flight and re-trigger the PDF lookup.
      this.#lastNode = node
      await this.searchNode(node)
    }
  }

  /**
   * The node whose position is looked up in the PDF, see {@link getPdfLookupNode}. Null if the
   * cursor is in an element without a single position in the PDF (e.g. in the whitespace
   * directly inside `<text>`), in which case the PDF viewer does not navigate.
   * @param {Element|null} cursorNode - the element at the cursor
   * @returns {Element|null}
   */
  #getSearchNode(cursorNode) {
    // Without a navigation xpath, the selected node is just the element at the cursor
    const xmlEditor = this.#xmlEditor
    const selectedNode = xmlEditor.parentPath ? xmlEditor.selectedNode : null
    return getPdfLookupNode(selectedNode, cursorNode)
  }

  /**
   * @param {CustomEvent} evt - `widget-change` event of the switch
   * @returns {Promise<void>}
   */
  async #onSwitchChange(evt) {
    const checked = Boolean(evt.detail.checked)
    evt.detail.widget?.setAttribute('help-text', checked ? 'on' : 'off')
    this.uiStorage.set(STORAGE_KEY, checked)
    this.#logger.info(`Sync with editor is: ${checked}`)
    const selectedNode = this.#xmlEditor.selectedNode
    if (checked && selectedNode) {
      await this.searchNode(selectedNode)
    }
  }

  /**
   * The persisted switch state. Migrates the state saved by the PDF viewer plugin,
   * which owned the switch before.
   * @returns {boolean}
   */
  #loadEnabled() {
    const legacyStorage = new UIStorage('pdfviewer')
    const legacy = legacyStorage.get('autosearch')
    if (legacy !== undefined) {
      legacyStorage.remove('autosearch')
      if (this.uiStorage.get(STORAGE_KEY) === undefined) {
        this.uiStorage.set(STORAGE_KEY, Boolean(legacy))
      }
    }
    return Boolean(this.uiStorage.get(STORAGE_KEY, false))
  }
}

export default EditorSyncPlugin

/**
 * Returns a list of non-empty text content from all text nodes contained in the given node
 * @param {Node} node
 * @returns {string[]}
 */
function getNodeText(node) {
  /** @type {string[]} */
  const texts = []
  const walk = (/** @type {Node} */ current) => {
    if (current.nodeType === Node.TEXT_NODE) {
      const text = current.textContent?.trim()
      if (text) texts.push(text)
    } else {
      for (const child of current.childNodes) walk(child)
    }
  }
  walk(node)
  return texts
}

/**
 * Returns the printed footnote identifier for a node, if the project's
 * ad-hoc convention applies: a `source="fnNN"` attribute on the node or an
 * ancestor marks the footnote the node was extracted from. This convention
 * is non-standard and may change - keep ALL knowledge of it inside this
 * function; callers only see "text to prepend to the PDF search query".
 * @param {Element} node
 * @returns {string|null} The printed footnote number, or null
 */
export function getSourceFootnoteId(node) {
  /** @type {Element|null} */
  let current = node
  while (current && current.nodeType === 1 /* ELEMENT_NODE */) {
    const source = current.getAttribute('source')
    if (source && /^fn\d+$/.test(source)) {
      return source.slice(2)
    }
    current = current.parentElement
  }
  return null
}

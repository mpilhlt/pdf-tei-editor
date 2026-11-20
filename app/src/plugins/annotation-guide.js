/**
 * Annotation Guide Plugin
 *
 * Displays variant-specific annotation guidelines in a left-side drawer.
 * Prefers the currently open document's own editorialDecl (Part A/F of
 * docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md);
 * falls back to the runtime, per-variant config for documents extracted
 * before that feature existed.
 *
 * The guide is rendered by app/src/modules/guide-viewer.js, which is shared
 * with the standalone guide window (app/src/guide.js, URL
 * `/guide/<guide id>#<heading>`). The search button in the header replaces
 * the title with a full-text search over the sections of the guide; the
 * "Open in new window" button shows the current section in the guide window
 * if the guide is one the extractors declare, otherwise on its own site.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDrawer, SlMenuItem } from '../ui.js'
 * @import { MarkdownHeading } from '../modules/markdown-utils.js'
 * @import { annotationGuideDrawerPart } from '../templates/annotation-guide-drawer.types.js'
 * @import { AnnotationGuideItem } from '../modules/api-client-v1.js'
 * @import { ManualSearchTarget } from '../modules/manual-search-box.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { getEditorialDeclGuides } from '../modules/tei-utils.js'
import { userHasRole } from '../modules/acl-utils.js'
import { hasMarkdownSection, spliceMarkdownSection } from '../modules/markdown-utils.js'
import { addHeadingLinkButtons, fitTocMenu, populateTocMenu, scrollToHeading, visibleHeadingAnchor } from '../modules/markdown-toc.js'
import { GuideViewer } from '../modules/guide-viewer.js'
import { buildIndex } from '../modules/manual-search.js'
import { ManualSearchBox, attachDrawerSearch, markSectionMatches } from '../modules/manual-search-box.js'
import { GUIDE_WINDOW_NAME, findGuide, guideWindowUrl } from '../modules/guide-links.js'
import { notify } from '../modules/sl-utils.js'

/**
 * Annotation guide information from extractor plugins
 * @typedef {object} AnnotationGuideInfo
 * @property {string[]} variant_ids - The variant identifier(s) this guide applies to; "*" means every variant
 * @property {string} [category] - The rule category this guide belongs to; not every extractor plugin populates this
 * @property {"html" | "markdown"} type - The content type
 * @property {string} url - The URL to fetch the guide from
 */

// Register template
await registerTemplate('annotation-guide-drawer', 'annotation-guide-drawer.html')

class AnnotationGuidePlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'annotation-guide', deps: ['help', 'extraction', 'dialog', 'logger'] })
  }

  get #extraction() { return this.getDependency('extraction') }
  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {SlDrawer & annotationGuideDrawerPart} */
  #ui = null

  /** @type {GuideViewer | null} */
  #viewer = null

  /** @type {ManualSearchBox | null} */
  #searchBox = null

  /** Shows or hides the search field in place of the title @type {(show: boolean) => void} */
  #toggleSearch = () => {}

  /** The Markdown shown (with the personal version spliced in), for the search index */
  #markdown = ''

  /** Title of the guide shown */
  #title = ''

  /**
   * The guide files the extractors declare, which the guide window shows (loaded once)
   * @type {Promise<AnnotationGuideItem[]> | null}
   */
  #windowGuides = null

  /** @type {AnnotationGuideInfo[]} */
  #annotationGuides = []

  /** @type {string | null} */
  #currentGuideUrl = null

  /** @type {MarkdownHeading[]} */
  #headings = []

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "annotation-guide"`)

    this.#ui = this.createUi(createSingleFromTemplate('annotation-guide-drawer', document.body))
    this.#viewer = new GuideViewer(this.#ui.content)
    this.#ui.closeBtn.addEventListener('click', () => this.#ui.hide())
    this.#ui.openWindowBtn.addEventListener('click', () => this.#openInNewWindow())
    this.#ui.tocDropdown.addEventListener('sl-show', () => fitTocMenu(this.#ui, this.#ui.tocDropdown.tocMenu))
    this.#ui.tocDropdown.tocMenu.addEventListener('sl-select', event => {
      const item = /** @type {SlMenuItem} */ (/** @type {CustomEvent} */ (event).detail.item)
      this.#scrollToHeading(Number(item.value))
    })

    this.#searchBox = new ManualSearchBox({
      input: this.#ui.searchInput,
      panel: this.#ui.searchResults,
      subject: 'the guide',
      groupByPage: false,
      loadIndex: async () => {
        if (!this.#markdown) throw new Error('No guide is shown')
        const viewer = /** @type {GuideViewer} */ (this.#viewer)
        return buildIndex([{ path: viewer.url, title: this.#title, markdown: this.#markdown }], () => viewer.md)
      },
      onOpen: target => this.#openSearchResult(target),
      onClose: () => this.#toggleSearch(false)
    })
    this.#toggleSearch = attachDrawerSearch(
      { drawer: this.#ui, button: this.#ui.searchBtn, input: this.#ui.searchInput, title: this.#ui.titleText },
      () => this.#searchBox
    )

    this.getDependency('help').registerTopic(
      'Annotation Guide',
      'file-text',
      () => this.open()
    )

    // @ts-ignore
    window.appAnnotationGuide = this
  }

  /**
   * Opens the annotation guide drawer
   */
  async open() {
    this.#ui.show()

    if (this.#annotationGuides.length === 0) {
      let extractors = this.#extraction.extractorInfo()
      if (!extractors) {
        extractors = await this.#client.getExtractorList()
      }
      if (extractors) {
        this.#annotationGuides = extractors.flatMap(e => e.annotationGuides || [])
      }
    }

    const variant = this.state?.variant
    if (variant) {
      await this.load(variant)
    } else {
      this.#showGuideControls(false)
      this.#updateToc([])
      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="info-circle" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p>No document loaded.</p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">
            Load a document to view its annotation guide.
          </p>
        </div>
      `
    }
  }

  /**
   * Loads annotation guide for a specific variant
   * @param {string} variant The variant identifier
   */
  async load(variant) {
    this.#toggleSearch(false)
    this.#ui.content.innerHTML = ""
    this.#updateToc([])

    const docGuide = this.#getDocumentPrimaryGuide()
    if (docGuide) {
      await this.#renderGuide(docGuide.markdownUrl, docGuide.htmlUrl, undefined, true)
      return
    }

    const variantGuides = this.#annotationGuides.filter(g => g.variant_ids.includes(variant) || g.variant_ids.includes('*'))
    const markdownGuide = variantGuides.find(g => g.type === 'markdown')
    const htmlGuide = variantGuides.find(g => g.type === 'html')
    await this.#renderGuide(markdownGuide?.url, htmlGuide?.url, variant)
  }

  /**
   * Closes the annotation guide drawer
   */
  close() {
    this.#ui.hide()
  }

  /**
   * Shows or hides the controls that need a guide (search, open in new window), and forgets the guide shown when
   * hiding them.
   * @param {boolean} show
   */
  #showGuideControls(show) {
    this.#ui.searchBtn.hidden = !show
    this.#ui.openWindowBtn.hidden = !show
    if (!show) {
      this.#markdown = ''
      this.#currentGuideUrl = null
    }
    this.#searchBox?.invalidate()
  }

  /**
   * The guide files the guide window shows, loaded once; none if they cannot be loaded.
   * @returns {Promise<AnnotationGuideItem[]>}
   */
  #getWindowGuides() {
    if (!this.#windowGuides) {
      this.#windowGuides = Promise.resolve()
        .then(() => this.#client.apiClient.annotationGuides())
        .then(response => response.guides)
        .catch(error => {
          this.getDependency('logger').warn(`Could not load the annotation guides: ${error instanceof Error ? error.message : String(error)}`)
          this.#windowGuides = null
          return []
        })
    }
    return this.#windowGuides
  }

  /**
   * The guide window URL of a section of the guide shown, if the guide window shows the guide.
   * @param {string} anchor - Heading anchor, "" for the top
   * @returns {Promise<string | null>}
   */
  async #windowUrl(anchor) {
    if (!this.#currentGuideUrl || !this.#markdown) return null
    const match = findGuide(await this.#getWindowGuides(), this.#currentGuideUrl)
    if (!match) return null
    return guideWindowUrl(match.guide.id, anchor, { ref: match.ref, origin: window.location.origin })
  }

  /**
   * Shows the section of the guide at the top of the drawer in the guide window, or the guide on its own site if
   * the guide window does not show it.
   */
  async #openInNewWindow() {
    if (!this.#currentGuideUrl) return
    let url = await this.#windowUrl(visibleHeadingAnchor(this.#ui, this.#ui.content))
    if (!url) {
      window.open(this.#currentGuideUrl, '_blank', 'noopener')
      return
    }
    // in development mode, the window loads the sources as well
    if (new URLSearchParams(window.location.search).has('dev')) {
      const [base, hash] = url.split('#')
      url = `${base}${base.includes('?') ? '&' : '?'}dev${hash ? `#${hash}` : ''}`
    }
    window.open(url, GUIDE_WINDOW_NAME, 'popup,width=1100,height=900')
  }

  /**
   * Copies the guide window URL of a heading to the clipboard.
   * @param {string} anchor - Heading anchor without "#"
   */
  async #copyLink(anchor) {
    const url = await this.#windowUrl(anchor)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      notify('Link copied to the clipboard', 'success', 'check-circle')
    } catch (error) {
      this.getDependency('logger').warn(`Could not copy ${url}: ${error instanceof Error ? error.message : String(error)}`)
      notify(`Could not copy the link: ${url}`, 'warning', 'exclamation-triangle', 10000)
    }
  }

  /**
   * Scrolls to a search result and highlights the query words in its section.
   * @param {ManualSearchTarget} target
   */
  #openSearchResult(target) {
    this.#toggleSearch(false)
    const heading = target.anchor
      ? this.#ui.content.querySelectorAll(`[id="${CSS.escape(target.anchor)}"]`)[target.occurrence] ?? null
      : null
    markSectionMatches(this.#ui.content, heading, target.words)
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      const body = this.#ui.shadowRoot?.querySelector('[part="body"]')
      if (body) body.scrollTop = 0
    }
  }

  /**
   * Rebuilds the table of contents menu from the given headings. Hides the
   * TOC trigger button if there are no headings.
   * @param {MarkdownHeading[]} headings
   */
  #updateToc(headings) {
    this.#headings = headings
    populateTocMenu(this.#ui.tocDropdown, this.#ui.tocDropdown.tocMenu, headings)
  }

  /**
   * Scrolls the drawer to the rendered heading of the TOC entry at `index`.
   * @param {number} index Index into the current headings
   */
  #scrollToHeading(index) {
    const heading = this.#headings[index]
    if (!heading) return
    if (!scrollToHeading(this.#ui.content, heading)) {
      this.getDependency('logger').warn(`Heading #${heading.anchor} not found in annotation guide`)
    }
  }

  /**
   * Reads the open document's editorialDecl `primary` guide entry's
   * "human" ref, if present.
   *
   * contentType can be null/unrecognized when a hand-edited or malformed
   * editorialDecl omits it, or the "primary" interpretation may have only
   * a "machine" ref and no "human" one at all (see the
   * getEditorialDeclGuides() contract in tei-utils.js) - either case is
   * treated the same as "no primary guide" so load() falls through to the
   * runtime per-variant config instead of a dead-end "no guide" message.
   * @returns {{markdownUrl: string|null, htmlUrl: string|null}|null}
   */
  #getDocumentPrimaryGuide() {
    const xmlDoc = this.#xmlEditor.getXmlTree()
    if (!xmlDoc) return null
    let guides
    try {
      guides = getEditorialDeclGuides(xmlDoc)
    } catch (error) {
      this.getDependency('logger').warn(`Could not read editorialDecl: ${String(error)}`)
      return null
    }
    const primary = guides.find(g => g.category === 'primary')
    if (!primary) return null
    const humanRef = primary.refs.find(r => r.subtype === 'human')
    if (!humanRef) return null
    const markdownUrl = humanRef.contentType === 'markdown' ? humanRef.target : null
    const htmlUrl = humanRef.contentType === 'html' ? humanRef.target : null
    if (!markdownUrl && !htmlUrl) return null
    return { markdownUrl, htmlUrl }
  }

  /**
   * For reviewers/admins, replaces the guide's `anchor` section with their selected
   * override of it and shows the "Personal version" badge. Returns `markdown`
   * unchanged (and logs a warning on errors) if there is no override.
   * @param {string} markdown - The fetched guide
   * @param {string} markdownUrl - The guide URL including its heading anchor
   * @param {string} anchor - Heading anchor of the section
   * @returns {Promise<string>}
   */
  async #applyPersonalVersion(markdown, markdownUrl, anchor) {
    if (!userHasRole(this.state?.user ?? null, ['reviewer', 'admin'])) return markdown
    try {
      const { override } = await this.#client.documentRulesSelectedOverride({ kind: 'interpretation-ref', url: markdownUrl })
      if (!override) return markdown
      if (!hasMarkdownSection(markdown, anchor)) return markdown
      this.#ui.personalBadge.title = override.note
      this.#ui.personalBadge.hidden = false
      return spliceMarkdownSection(markdown, anchor, override.text)
    } catch (error) {
      this.getDependency('logger').warn(`Could not load the personal version of the annotation guide: ${error instanceof Error ? error.message : String(error)}`)
      return markdown
    }
  }

  /**
   * Renders a guide into the drawer: fetches and renders markdownUrl if
   * given, otherwise shows htmlUrl as an external-only link, otherwise
   * shows a "no guide" message. Applies the GitHub/GitLab blob-to-raw
   * transform to markdownUrl before fetching (a no-op for URLs from other
   * hosts, e.g. a HedgeDoc pad's /download URL).
   * @param {string|undefined|null} markdownUrl
   * @param {string|undefined|null} htmlUrl
   * @param {string} [variantForMessage] - Used only in the "no guide" message text
   * @param {boolean} [fromDocument=false] - Whether the guide is the open document's human ref, for which a
   *   reviewer/admin's selected override of the heading-anchor section is shown as a "Personal version"
   */
  async #renderGuide(markdownUrl, htmlUrl, variantForMessage, fromDocument = false) {
    this.#ui.personalBadge.hidden = true
    this.#showGuideControls(false)

    if (!markdownUrl && !htmlUrl) {
      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="info-circle" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p>No annotation guide is available${variantForMessage ? ` for variant: <strong>${variantForMessage}</strong>` : ''}</p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">
            Check back later or contact your administrator for documentation.
          </p>
        </div>
      `
      return
    }

    if (!markdownUrl && htmlUrl) {
      this.#currentGuideUrl = htmlUrl
      this.#ui.openWindowBtn.hidden = false
      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="box-arrow-up-right" style="font-size: 2rem; margin-bottom: 1rem;"></sl-icon>
          <p>The annotation guide for this variant is available as an external page.</p>
          <p style="margin-top: 1rem;">
            <a href="${htmlUrl}" target="_blank" rel="noopener">Open Annotation Guide</a>
          </p>
        </div>
      `
      return
    }

    const [baseUrl, anchor] = /** @type {string} */(markdownUrl).split('#')
    const viewer = /** @type {GuideViewer} */ (this.#viewer)
    const logger = this.getDependency('logger')

    try {
      logger.debug(`Loading annotation guide from: ${baseUrl}`)
      let markdown = await viewer.fetch(baseUrl)
      if (fromDocument && anchor && !/^L\d+(-L?\d+)?$/.test(anchor)) {
        markdown = await this.#applyPersonalVersion(markdown, /** @type {string} */(markdownUrl), anchor)
      }

      const rendered = viewer.render(markdown, baseUrl)
      this.#markdown = markdown
      this.#title = rendered.title
      this.#currentGuideUrl = /** @type {string} */ (markdownUrl)
      this.#showGuideControls(true)
      this.#updateToc(rendered.headings)
      if (findGuide(await this.#getWindowGuides(), baseUrl)) {
        addHeadingLinkButtons(this.#ui.content, headingAnchor => this.#copyLink(headingAnchor))
      }

      if (anchor) {
        setTimeout(() => {
          if (!viewer.scrollToAnchor(anchor)) {
            logger.warn(`Anchor #${anchor} not found in annotation guide`)
          }
        }, 100)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`Failed to load annotation guide: ${errorMessage}`)
      this.getDependency('dialog').error(`Failed to load annotation guide: ${errorMessage}`)

      this.#ui.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-danger-600);">
          <sl-icon name="exclamation-octagon" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p><strong>Error loading annotation guide</strong></p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">${errorMessage}</p>
        </div>
      `
    }
  }
}

export default AnnotationGuidePlugin


export const plugin = AnnotationGuidePlugin

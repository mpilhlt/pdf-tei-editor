/**
 * Annotation Guide Plugin
 *
 * Displays variant-specific annotation guidelines in a left-side drawer.
 * Prefers the currently open document's own editorialDecl (Part A/F of
 * docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md);
 * falls back to the runtime, per-variant config for documents extracted
 * before that feature existed.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import MarkdownIt from 'markdown-it'
 * @import { SlDrawer } from '../ui.js'
 * @import { annotationGuideDrawerPart } from '../templates/annotation-guide-drawer.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { getEditorialDeclGuides } from '../modules/tei-utils.js'
import { blobUrlToRawUrl } from '../modules/git-forge-urls.js'
import {
  createMarkdownRenderer,
  fetchMarkdown,
  renderMarkdown
} from '../modules/markdown-utils.js'

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

  /** @type {MarkdownIt | null} */
  #md = null

  /** @type {AnnotationGuideInfo[]} */
  #annotationGuides = []

  /** @type {string | null} */
  #currentGuideUrl = null

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "annotation-guide"`)

    this.#ui = this.createUi(createSingleFromTemplate('annotation-guide-drawer', document.body))
    this.#ui.closeBtn.addEventListener('click', () => this.#ui.hide())
    this.#ui.openInNewWindowBtn.addEventListener('click', () => this.#openInNewWindow())

    this.getDependency('help').registerTopic(
      'Annotation Guide',
      'file-text',
      () => this.open()
    )

    this.#md = createMarkdownRenderer()

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
      this.#ui.openInNewWindowBtn.hidden = true
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
    this.#ui.content.innerHTML = ""

    const docGuide = this.#getDocumentPrimaryGuide()
    if (docGuide) {
      await this.#renderGuide(docGuide.markdownUrl, docGuide.htmlUrl)
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
   * Opens the currently displayed guide's URL in a new browser tab/window,
   * if one is set.
   */
  #openInNewWindow() {
    if (this.#currentGuideUrl) {
      window.open(this.#currentGuideUrl, '_blank')
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
   * Renders a guide into the drawer: fetches and renders markdownUrl if
   * given, otherwise shows htmlUrl as an external-only link, otherwise
   * shows a "no guide" message. Applies the GitHub/GitLab blob-to-raw
   * transform to markdownUrl before fetching (a no-op for URLs from other
   * hosts, e.g. a HedgeDoc pad's /download URL).
   * @param {string|undefined|null} markdownUrl
   * @param {string|undefined|null} htmlUrl
   * @param {string} [variantForMessage] - Used only in the "no guide" message text
   */
  async #renderGuide(markdownUrl, htmlUrl, variantForMessage) {
    this.#currentGuideUrl = htmlUrl || markdownUrl || null
    this.#ui.openInNewWindowBtn.hidden = !this.#currentGuideUrl

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
    const fetchUrl = blobUrlToRawUrl(baseUrl)

    try {
      const logger = this.getDependency('logger')
      logger.debug(`Loading annotation guide from: ${fetchUrl}`)
      const markdown = await fetchMarkdown(fetchUrl, true)

      const html = renderMarkdown(/** @type {MarkdownIt} */(this.#md), markdown, {
        localLinkHandler: 'appAnnotationGuide.load',
        openExternalInNewTab: true
      })

      this.#ui.content.innerHTML = html

      if (anchor) {
        setTimeout(() => {
          const targetElement = this.#ui.content.querySelector(`#${anchor}`)
          if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
          } else {
            logger.warn(`Anchor #${anchor} not found in annotation guide`)
          }
        }, 100)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.getDependency('logger').error(`Failed to load annotation guide: ${errorMessage}`)
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

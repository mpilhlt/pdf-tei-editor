/**
 * Annotation Guide Plugin
 *
 * Displays variant-specific annotation guidelines in a left-side drawer.
 * Fetches markdown documentation from configured URLs and renders it.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import MarkdownIt from 'markdown-it'
 * @import { SlButton } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ui from '../ui.js'
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js'
import {
  createMarkdownRenderer,
  fetchMarkdown,
  renderMarkdown
} from '../modules/markdown-utils.js'
import { api as extraction } from './extraction.js'
import { api as clientApi } from './client.js'

/**
 * Annotation guide information from extractor plugins
 * @typedef {object} AnnotationGuideInfo
 * @property {string} variant_id - The variant identifier
 * @property {"html" | "markdown"} type - The content type
 * @property {string} url - The URL to fetch the guide from
 */

/**
 * Annotation Guide Drawer
 * @typedef {object} annotationGuideDrawerPart
 * @property {HTMLDivElement} content
 * @property {SlButton} openInNewWindowBtn
 * @property {SlButton} closeBtn
 */

// Register template
await registerTemplate('annotation-guide-drawer', 'annotation-guide-drawer.html')

class AnnotationGuidePlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'annotation-guide', deps: ['help', 'extraction', 'dialog', 'logger'] })
  }

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
    const logger = this.getDependency('logger')
    logger.debug(`Installing plugin "annotation-guide"`)

    createFromTemplate('annotation-guide-drawer', document.body)

    ui.annotationGuideDrawer.closeBtn.addEventListener('click', () => ui.annotationGuideDrawer.hide())
    ui.annotationGuideDrawer.openInNewWindowBtn.addEventListener('click', () => this.#openInNewWindow())

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
    ui.annotationGuideDrawer.show()

    if (this.#annotationGuides.length === 0) {
      let extractors = extraction.extractorInfo()
      if (!extractors) {
        extractors = await clientApi.getExtractorList()
      }
      if (extractors) {
        this.#annotationGuides = extractors.flatMap(e => e.annotationGuides || [])
      }
    }

    const variant = this.state?.variant
    if (variant) {
      await this.load(variant)
    } else {
      ui.annotationGuideDrawer.openInNewWindowBtn.hidden = true
      ui.annotationGuideDrawer.content.innerHTML = `
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
    ui.annotationGuideDrawer.content.innerHTML = ""

    const variantGuides = this.#annotationGuides.filter(g => g.variant_id === variant)
    const markdownGuide = variantGuides.find(g => g.type === 'markdown')
    const htmlGuide = variantGuides.find(g => g.type === 'html')

    this.#currentGuideUrl = htmlGuide?.url || null
    ui.annotationGuideDrawer.openInNewWindowBtn.hidden = !htmlGuide

    if (!markdownGuide && !htmlGuide) {
      ui.annotationGuideDrawer.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="info-circle" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p>No annotation guide is available for variant: <strong>${variant}</strong></p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">
            Check back later or contact your administrator for documentation.
          </p>
        </div>
      `
      return
    }

    if (!markdownGuide && htmlGuide) {
      ui.annotationGuideDrawer.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-600);">
          <sl-icon name="box-arrow-up-right" style="font-size: 2rem; margin-bottom: 1rem;"></sl-icon>
          <p>The annotation guide for this variant is available as an external page.</p>
          <p style="margin-top: 1rem;">
            <a href="${htmlGuide.url}" target="_blank" rel="noopener">Open Annotation Guide</a>
          </p>
        </div>
      `
      return
    }

    const guideUrl = /** @type {AnnotationGuideInfo} */(markdownGuide).url
    const [fetchUrl, anchor] = guideUrl.split('#')

    try {
      const logger = this.getDependency('logger')
      logger.debug(`Loading annotation guide from: ${fetchUrl}`)
      const markdown = await fetchMarkdown(fetchUrl, true)

      const html = renderMarkdown(/** @type {MarkdownIt} */(this.#md), markdown, {
        localLinkHandler: 'appAnnotationGuide.load',
        openExternalInNewTab: true
      })

      ui.annotationGuideDrawer.content.innerHTML = html

      if (anchor) {
        setTimeout(() => {
          const targetElement = ui.annotationGuideDrawer.content.querySelector(`#${anchor}`)
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

      ui.annotationGuideDrawer.content.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--sl-color-danger-600);">
          <sl-icon name="exclamation-octagon" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
          <p><strong>Error loading annotation guide</strong></p>
          <p style="margin-top: 1rem; font-size: 0.875rem;">${errorMessage}</p>
        </div>
      `
    }
  }

  /**
   * Closes the annotation guide drawer
   */
  close() {
    ui.annotationGuideDrawer.hide()
  }

  #openInNewWindow() {
    if (this.#currentGuideUrl) {
      window.open(this.#currentGuideUrl, '_blank')
    }
  }
}

export default AnnotationGuidePlugin

/** @deprecated Use getDependency('annotation-guide') instead */
export const api = new Proxy({}, {
  get(_, prop) {
    const instance = AnnotationGuidePlugin.getInstance()
    const value = instance[prop]
    return typeof value === 'function' ? value.bind(instance) : value
  },
  set(_, prop, value) {
    AnnotationGuidePlugin.getInstance()[prop] = value
    return true
  }
})

export const plugin = AnnotationGuidePlugin

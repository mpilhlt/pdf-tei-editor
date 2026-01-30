/**
 * Annotation Guide Plugin
 *
 * Displays variant-specific annotation guidelines in a left-side drawer.
 * Fetches markdown documentation from configured URLs and renders it.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import MarkdownIt from 'markdown-it'
 */
import ui from '../ui.js'
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js'
import { dialog, logger, helpPlugin, client } from '../app.js'
import { extraction } from '../plugins.js'
import {
  createMarkdownRenderer,
  fetchMarkdown,
  renderMarkdown
} from '../modules/markdown-utils.js'

/**
 * Annotation guide information from extractor plugins
 * @typedef {object} AnnotationGuideInfo
 * @property {string} variant_id - The variant identifier
 * @property {"html" | "markdown"} type - The content type
 * @property {string} url - The URL to fetch the guide from
 */

/**
 * plugin API
 */
const api = {
  open,
  load,
  close
}

/**
 * Plugin object
 */
const plugin = {
  name: "annotation-guide",
  deps: ['help', 'extraction'],
  install,
  onStateUpdate
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * Annotation Guide Drawer
 * @typedef {object} annotationGuideDrawerPart
 * @property {HTMLDivElement} content
 * @property {SlButton} openInNewWindowBtn
 * @property {SlButton} closeBtn
 */

/**
 * The markdown renderer
 * @type {MarkdownIt}
 */
let md

/**
 * Annotation guides collected from all extractors
 * @type {AnnotationGuideInfo[]}
 */
let annotationGuides = []

/**
 * Current state reference (updated via onStateUpdate)
 * @type {ApplicationState | null}
 */
let currentState = null

/**
 * Current guide URL (for opening in new window)
 * @type {string | null}
 */
let currentGuideUrl = null

// Register template
await registerTemplate('annotation-guide-drawer', 'annotation-guide-drawer.html')

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state The main application
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create UI elements
  createFromTemplate('annotation-guide-drawer', document.body)

  // Set up drawer event listeners
  ui.annotationGuideDrawer.closeBtn.addEventListener('click', () => ui.annotationGuideDrawer.hide())
  ui.annotationGuideDrawer.openInNewWindowBtn.addEventListener('click', openInNewWindow)

  // Register topic with help plugin
  helpPlugin.registerTopic(
    'Annotation Guide',
    'file-text', // <sl-icon name="file-text">
    () => api.open()
  )

  // Configure markdown parser
  md = createMarkdownRenderer()

  // @ts-ignore
  window.appAnnotationGuide = api
}

/**
 * Reacts to state changes, tracking the current state
 * @param {string[]} _changedKeys - The state properties that changed (unused)
 * @param {ApplicationState} state - The current state
 */
async function onStateUpdate(_changedKeys, state) {
  currentState = state
}

/**
 * Opens the annotation guide drawer
 * Loads guide for current variant if available
 */
async function open() {
  ui.annotationGuideDrawer.show()

  // Collect annotation guides from all extractors (lazy load)
  if (annotationGuides.length === 0) {
    let extractors = extraction.extractorInfo()
    // Fallback to direct API call if extractors not yet loaded
    if (!extractors) {
      extractors = await client.getExtractorList()
    }
    if (extractors) {
      annotationGuides = extractors.flatMap(e => e.annotationGuides || [])
    }
  }

  // Load guide for current variant from state
  const variant = currentState?.variant
  if (variant) {
    await load(variant)
  } else {
    // No variant - hide the button and show message
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
async function load(variant) {
  // Clear existing content
  ui.annotationGuideDrawer.content.innerHTML = ""

  // Find guides for this variant
  const variantGuides = annotationGuides.filter(g => g.variant_id === variant)
  const markdownGuide = variantGuides.find(g => g.type === 'markdown')
  const htmlGuide = variantGuides.find(g => g.type === 'html')

  // Store HTML URL for opening in new window
  currentGuideUrl = htmlGuide?.url || null

  // Show/hide the "Open in new window" button based on HTML availability
  ui.annotationGuideDrawer.openInNewWindowBtn.hidden = !htmlGuide

  // No guides available for this variant
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

  // Only HTML available (no markdown) - show link to external page
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

  // Markdown available - fetch and render
  const guideUrl = markdownGuide.url
  const [fetchUrl, anchor] = guideUrl.split('#')

  try {
    logger.debug(`Loading annotation guide from: ${fetchUrl}`)
    const markdown = await fetchMarkdown(fetchUrl, true)

    const html = renderMarkdown(md, markdown, {
      localLinkHandler: 'appAnnotationGuide.load',
      openExternalInNewTab: true
    })

    ui.annotationGuideDrawer.content.innerHTML = html

    // Scroll to anchor if specified
    if (anchor) {
      // Wait for next tick to ensure DOM is updated
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
    logger.error(`Failed to load annotation guide: ${error.message}`)
    dialog.error(`Failed to load annotation guide: ${error.message}`)

    // Show error message in drawer
    ui.annotationGuideDrawer.content.innerHTML = `
      <div style="padding: 2rem; text-align: center; color: var(--sl-color-danger-600);">
        <sl-icon name="exclamation-octagon" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
        <p><strong>Error loading annotation guide</strong></p>
        <p style="margin-top: 1rem; font-size: 0.875rem;">${error.message}</p>
      </div>
    `
  }
}

/**
 * Opens the current annotation guide in a new browser window
 */
function openInNewWindow() {
  if (currentGuideUrl) {
    window.open(currentGuideUrl, '_blank')
  }
}

/**
 * Closes the annotation guide drawer
 */
function close() {
  ui.annotationGuideDrawer.hide()
}

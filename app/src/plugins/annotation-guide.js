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
import { dialog, logger, helpPlugin } from '../app.js'
import {
  createMarkdownRenderer,
  fetchMarkdown,
  renderMarkdown
} from '../modules/markdown-utils.js'

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
  deps: ['help'],
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
 * @property {SlButton} closeBtn
 */

/**
 * The markdown renderer
 * @type {MarkdownIt}
 */
let md

/**
 * Static mapping from variant values to annotation guide URLs
 * TODO: Replace with dynamic system
 * @type {Map<string, string>}
 */
const variantGuideUrls = new Map([
  ['grobid.training.segmentation', 'https://pad.gwdg.de/s/1Oti-hJDb/download#segmentation'],
  ['grobid.training.references', 'https://pad.gwdg.de/s/1Oti-hJDb/download#reference-segmenter'],
  ['llamore-default', 'https://pad.gwdg.de/s/LSqaEtZyT/download']
])

/**
 * Current state reference (updated via onStateUpdate)
 * @type {ApplicationState | null}
 */
let currentState = null

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

  // Load guide for current variant from state
  const variant = currentState?.variant
  if (variant) {
    await load(variant)
  }
}

/**
 * Loads annotation guide for a specific variant
 * @param {string} variant The variant identifier
 */
async function load(variant) {
  // Clear existing content
  ui.annotationGuideDrawer.content.innerHTML = ""

  // Check if guide URL exists for this variant
  const guideUrl = variantGuideUrls.get(variant)

  if (!guideUrl) {
    // Display message when no guide is available
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

  // Split URL and anchor
  const [fetchUrl, anchor] = guideUrl.split('#')

  // Fetch and render markdown
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
 * Closes the annotation guide drawer
 */
function close() {
  ui.annotationGuideDrawer.hide()
}

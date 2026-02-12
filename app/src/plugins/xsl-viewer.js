/**
 * XSL Transformation Viewer Plugin
 * Displays XSL transformation results in an overlay over the XML editor.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { SlIconButton, SlDropdown, SlMenu, SlMenuItem } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js';
import ui, { updateUi } from '../ui.js';
import { api as xmlEditor } from './xmleditor.js';
import { notify } from '../modules/sl-utils.js';
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js';
import { prettyPrintNode } from '../modules/tei-utils.js';

// Register templates at module level
await registerTemplate('xsl-viewer-button', 'xsl-viewer-button.html');
await registerTemplate('xsl-viewer-overlay', 'xsl-viewer-overlay.html');

/**
 * XSL stylesheet registration options
 * @typedef {object} XslStylesheetRegistration
 * @property {string} label - Display label for the stylesheet
 * @property {string} xmlns - XML namespace this stylesheet applies to
 * @property {Document} xslDoc - Pre-parsed XSLT document
 */

/**
 * XSL viewer overlay UI structure
 * @typedef {object} xslViewerOverlayPart
 * @property {HTMLSpanElement} overlayTitle - Title text
 * @property {SlIconButton} closeBtn - Close button
 * @property {HTMLDivElement} content - Content container
 */

/**
 * XSL viewer toolbar UI elements (added to xmlEditorToolbarPart)
 * @typedef {object} xslViewerToolbarPart
 * @property {SlDropdown} xslViewerDropdown - The dropdown
 * @property {StatusButton} xslViewerBtn - The trigger button
 * @property {SlMenu} xslViewerMenu - The menu
 */

/** @type {XslStylesheetRegistration[]} */
const registeredStylesheets = [];

// Direct references to UI elements (since nested in sl-dropdown)
/** @type {import('../ui.js').SlButton|null} */
let xslViewerBtn = null;
/** @type {SlMenu|null} */
let xslViewerMenu = null;
/** @type {HTMLDivElement|null} */
let xslViewerOverlay = null;

/**
 * XSL Transformation Viewer Plugin
 */
export class XslViewerPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, {
      name: 'xsl-viewer',
      deps: ['xmleditor']
    });
  }

  /**
   * Get singleton instance
   * @returns {XslViewerPlugin}
   */
  static getInstance() {
    return /** @type {XslViewerPlugin} */ (Plugin.getInstance.call(this));
  }

  /**
   * Register an XSL stylesheet
   * @param {XslStylesheetRegistration} options
   */
  register(options) {
    if (!options.label || !options.xmlns || !options.xslDoc) {
      console.error('XslViewerPlugin: Invalid registration - missing label, xmlns, or xslDoc');
      return;
    }

    // Check for parse errors in the XSLT document
    const parseError = options.xslDoc.querySelector('parsererror');
    if (parseError) {
      console.error('XslViewerPlugin: Invalid XSLT document:', parseError.textContent);
      return;
    }

    const existing = registeredStylesheets.findIndex(s =>
      s.label === options.label && s.xmlns === options.xmlns
    );

    if (existing >= 0) {
      registeredStylesheets[existing] = options;
    } else {
      registeredStylesheets.push(options);
    }

    this.updateMenu();
    this.updateButtonState();
  }

  /**
   * Get registered stylesheets
   * @returns {XslStylesheetRegistration[]}
   */
  getStylesheets() {
    return [...registeredStylesheets];
  }

  /**
   * Install the plugin
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);

    // Add overlay to xmlEditor container
    const overlayElement = createSingleFromTemplate('xsl-viewer-overlay');
    ui.xmlEditor.appendChild(overlayElement);
    xslViewerOverlay = overlayElement;

    // Add button to toolbar (priority 50.5 - between TEI buttons and spacer)
    const buttonElement = createSingleFromTemplate('xsl-viewer-button');
    ui.xmlEditor.toolbar.add(buttonElement, 50.5);

    // Store direct references to nested elements (sl-dropdown doesn't expose them via updateUi)
    xslViewerBtn = /** @type {import('../ui.js').SlButton} */ (buttonElement.querySelector('[name="xslViewerBtn"]'));
    xslViewerMenu = /** @type {SlMenu} */ (buttonElement.querySelector('[name="xslViewerMenu"]'));

    // Fix z-index stacking context: toggle dropdown-open class on toolbar
    // This ensures the dropdown menu appears above the editor content
    const dropdown = /** @type {SlDropdown} */ (buttonElement.querySelector('[name="xslViewerDropdown"]'));
    const tooltip = /** @type {import('../ui.js').SlTooltip} */ (buttonElement.closest('sl-tooltip'));
    if (dropdown) {
      dropdown.addEventListener('sl-show', () => {
        dropdown.closest('tool-bar')?.classList.add('dropdown-open');
        // Hide tooltip when dropdown opens so it doesn't obscure the menu
        if (tooltip) tooltip.hide();
      });
      dropdown.addEventListener('sl-hide', () => {
        dropdown.closest('tool-bar')?.classList.remove('dropdown-open');
      });
    }

    updateUi();

    // Setup event handlers
    const closeBtn = /** @type {SlIconButton} */ (overlayElement.querySelector('[data-name="closeBtn"]'));
    closeBtn.addEventListener('click', () => {
      this.hideOverlay();
    });

    // Copy button handler - copies as rich HTML for pasting into documents
    const copyBtn = /** @type {SlIconButton} */ (overlayElement.querySelector('[data-name="copyBtn"]'));
    copyBtn.addEventListener('click', async () => {
      const content = overlayElement.querySelector('[name="content"]');
      if (content) {
        try {
          const html = content.innerHTML;
          const blob = new Blob([html], { type: 'text/html' });
          const item = new ClipboardItem({
            'text/html': blob,
            'text/plain': new Blob([content.innerText], { type: 'text/plain' })
          });
          await navigator.clipboard.write([item]);
          notify('Copied to clipboard', 'success', 'check-circle');
        } catch (err) {
          // Fallback to plain text if rich copy fails
          try {
            await navigator.clipboard.writeText(content.innerText);
            notify('Copied as plain text', 'warning', 'exclamation-triangle');
          } catch (fallbackErr) {
            notify('Failed to copy to clipboard', 'danger', 'exclamation-octagon');
          }
        }
      }
    });

    // Menu selection handler
    xslViewerMenu.addEventListener('sl-select', (event) => {
      const item = /** @type {SlMenuItem} */ (event.detail.item);
      const label = item.dataset.label;
      if (label) {
        this.applyStylesheet(label);
      }
    });

    // Initialize menu with empty state
    this.updateMenu();
  }

  /**
   * Update menu items based on registered stylesheets and current document
   */
  updateMenu() {
    if (!xslViewerMenu) return;

    xslViewerMenu.innerHTML = '';

    const currentXmlns = this.getCurrentDocumentXmlns();

    if (registeredStylesheets.length === 0) {
      const item = document.createElement('sl-menu-item');
      item.textContent = 'No stylesheets registered';
      item.disabled = true;
      xslViewerMenu.appendChild(item);
      return;
    }

    registeredStylesheets.forEach(stylesheet => {
      const item = /** @type {SlMenuItem} */ (document.createElement('sl-menu-item'));
      item.textContent = stylesheet.label;
      item.dataset.label = stylesheet.label;
      item.disabled = !currentXmlns || stylesheet.xmlns !== currentXmlns;
      xslViewerMenu.appendChild(item);
    });
  }

  /**
   * Update button enabled state based on available stylesheets
   */
  updateButtonState() {
    if (!xslViewerBtn) {
      return;
    }

    const hasStylesheets = registeredStylesheets.length > 0;
    const hasMatchingXmlns = this.hasMatchingStylesheet();
    const shouldBeDisabled = !hasStylesheets || !hasMatchingXmlns;

    xslViewerBtn.disabled = shouldBeDisabled;
  }

  /**
   * Get the xmlns of the current document's root element
   * @returns {string|null}
   */
  getCurrentDocumentXmlns() {
    const xmlTree = xmlEditor.getXmlTree();
    if (!xmlTree || !xmlTree.documentElement) {
      return null;
    }
    return xmlTree.documentElement.namespaceURI;
  }

  /**
   * Check if any stylesheet matches the current document
   * @returns {boolean}
   */
  hasMatchingStylesheet() {
    const xmlns = this.getCurrentDocumentXmlns();
    if (!xmlns) return false;
    return registeredStylesheets.some(s => s.xmlns === xmlns);
  }

  /**
   * Apply a stylesheet by label
   * @param {string} label
   */
  applyStylesheet(label) {
    const stylesheet = registeredStylesheets.find(s => s.label === label);
    if (!stylesheet) {
      notify('Stylesheet not found', 'danger', 'exclamation-octagon');
      return;
    }

    const xmlTree = xmlEditor.getXmlTree();
    if (!xmlTree) {
      notify('No XML document loaded', 'warning', 'exclamation-triangle');
      return;
    }

    try {
      console.log('Applying stylesheet:', label);
      console.log('Stylesheet document:', stylesheet.xslDoc);
      console.log('Source XML document:', xmlTree);

      const xsltProcessor = new XSLTProcessor();
      xsltProcessor.importStylesheet(stylesheet.xslDoc);

      const resultDoc = xsltProcessor.transformToDocument(xmlTree);

      // Check for transformation errors in the result document
      if (!resultDoc) {
        throw new Error('Transformation returned null document');
      }

      // Check for parsererror in result (common in Firefox)
      const parseError = resultDoc.querySelector('parsererror');
      if (parseError) {
        console.error('XSLT Parse Error:', parseError.textContent);
        throw new Error(`XSLT Parse Error: ${parseError.textContent}`);
      }

      // Check for transformation-error (common in Chrome)
      const transformError = resultDoc.querySelector('transformiix\\:result, transform-error');
      if (transformError) {
        console.error('XSLT Transformation Error:', transformError.textContent);
        throw new Error(`XSLT Transformation Error: ${transformError.textContent}`);
      }

      console.log('Transformation successful, result:', resultDoc);

      // Display result in overlay
      this.showOverlay(stylesheet.label, resultDoc);

    } catch (error) {
      console.error('XSL transformation failed:', error);
      console.error('Error stack:', error.stack);
      console.error('Stylesheet that failed:', stylesheet);
      notify(`Transformation failed: ${error.message || 'Unknown error'}`, 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Show the overlay with transformation result
   * @param {string} title
   * @param {Document} resultDoc
   */
  showOverlay(title, resultDoc) {
    if (!xslViewerOverlay) return;

    const overlayTitle = xslViewerOverlay.querySelector('[name="overlayTitle"]');
    const content = xslViewerOverlay.querySelector('[name="content"]');

    if (overlayTitle) overlayTitle.textContent = title;
    if (!content) return;

    content.innerHTML = '';

    if (resultDoc.body) {
      // HTML result - copy the body content
      content.innerHTML = resultDoc.body.innerHTML;

      // Check if there are XML elements that need serialization
      // This pattern allows XSLT to generate XML structures that get serialized for display
      const xmlSources = content.querySelectorAll('.xsl-xml-source');
      const xmlTargets = content.querySelectorAll('.xsl-xml-target');

      if (xmlSources.length > 0 && xmlTargets.length > 0) {
        const serializer = new XMLSerializer();

        // Match each source with its corresponding target (by index)
        for (let i = 0; i < Math.min(xmlSources.length, xmlTargets.length); i++) {
          const xmlSource = xmlSources[i];
          const xmlTarget = xmlTargets[i];

          if (xmlSource.firstElementChild) {
            // Clone the element to avoid modifying the original
            const xmlElement = xmlSource.firstElementChild.cloneNode(true);
            // Apply pretty-printing
            prettyPrintNode(xmlElement);
            // Serialize to string
            let xmlString = serializer.serializeToString(xmlElement);
            // Remove XHTML namespace artifacts that appear when generating XML in HTML output mode
            // Remove namespace prefix declarations like xmlns:a0="http://www.w3.org/1999/xhtml"
            xmlString = xmlString.replace(/\s+xmlns:a\d+="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
            // Remove prefixes from element tags like <a0:element> -> <element>
            xmlString = xmlString.replace(/<(\/?)a\d+:/g, '<$1');
            xmlTarget.textContent = xmlString;
          }
        }
      }

      // Manually execute any scripts (innerHTML doesn't execute them)
      // Specifically for highlight.js
      if (typeof hljs !== 'undefined') {
        // Wait a tick for DOM to settle
        setTimeout(() => {
          hljs.highlightAll();
        }, 0);
      }
    } else if (resultDoc.documentElement) {
      // XML or other result - serialize and display as preformatted text
      const serializer = new XMLSerializer();
      const xmlString = serializer.serializeToString(resultDoc);
      const pre = document.createElement('pre');
      pre.textContent = xmlString;
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      content.appendChild(pre);
    }

    xslViewerOverlay.style.display = 'flex';
  }

  /**
   * Hide the overlay
   */
  hideOverlay() {
    if (!xslViewerOverlay) return;
    xslViewerOverlay.style.display = 'none';
    const content = xslViewerOverlay.querySelector('[name="content"]');
    if (content) content.innerHTML = '';
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('xml')) {
      // Update button enabled state and menu items
      this.updateButtonState();
      this.updateMenu();

      // Hide overlay when document changes
      this.hideOverlay();
    }
  }
}

export default XslViewerPlugin;

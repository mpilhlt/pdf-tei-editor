/**
 * The UI of the application as a typed object structure, which can then be traversed. 
 * In this structure, each named DOM element encapsulates all named descencdent elements.
 * This allows to access the elements via `ui.toolbar.pdf`, `ui.floatingPanel`, etc. The structure
 * is created by the `accessNamedDescendentsAsProperties` function, which is called on the document
 * body at the end of this file. The JSDoc structure is used to document the UI elements and their 
 * properties and allow autocompletion in IDEs that support JSDoc.   
 */

import { createNavigableElement } from './modules/browser-utils.js';

import { Spinner } from './modules/spinner.js'
import SlDialog from '@shoelace-style/shoelace/dist/components/dialog/dialog.js'
import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js'
import SlButtonGroup from '@shoelace-style/shoelace/dist/components/button-group/button-group.js'
import SlTextarea from '@shoelace-style/shoelace/dist/components/textarea/textarea.js'
import SlInput from '@shoelace-style/shoelace/dist/components/input/input.js'
import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'
import SlIcon from '@shoelace-style/shoelace/dist/components/icon/icon.js'
import SlTooltip from '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'
import SlPopup from '@shoelace-style/shoelace/dist/components/popup/popup.js';
import SlDropdown from '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js';
import SlMenu from '@shoelace-style/shoelace/dist/components/menu/menu.js'
import SlMenuItem from '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js'
import SlCheckbox  from '@shoelace-style/shoelace/dist/components/checkbox/checkbox.js';
import SlDivider from '@shoelace-style/shoelace/dist/components/divider/divider.js';
import SlSwitch from '@shoelace-style/shoelace/dist/components/switch/switch.js';

// Import statusbar components early so web components are defined
import './modules/statusbar/index.js';

/**
 * Import type definitions from plugins
 * 
 * @import {dialogComponent} from './plugins/dialog.js'
 * @import {promptEditorComponent} from './plugins/prompt-editor.js'
 * @import {floatingPanelComponent} from './plugins/floating-panel.js'
 * @import {documentActionsComponent, teiServicesComponent} from './plugins/services.js'
 * @import {extractionActionsComponent, extractionOptionsDialog} from './plugins/extraction.js'
 * @import {infoDialogComponent} from './plugins/info.js'
 * @import {loginDialog} from './plugins/authentication.js'
 * @import {pdfViewerComponent} from './plugins/pdfviewer.js'
 * @import {xmlEditorComponent} from './plugins/xmleditor.js'
 * @import {toolbarComponent} from './plugins/toolbar.js'
 * @import {teiWizardDialogComponent} from './plugins/tei-wizard.js'
 */

/**
 * Generic UI element type that combines DOM element properties with navigation properties
 * @template {Element} T - The DOM element type
 * @template {Record<string, any>} N - The navigation properties type
 * @typedef {T & N} UIElement
 */

/**
 * The top-level UI parts
 * @typedef {object} namedElementsTree
 * @property {UIElement<HTMLDivElement, toolbarComponent>} toolbar - The main toolbar
 * @property {UIElement<HTMLDivElement, floatingPanelComponent>} floatingPanel - The floating panel with navigation buttons
 * @property {UIElement<HTMLDivElement, pdfViewerComponent>} pdfViewer - The PDFJS-based PDF viewer with statusbar
 * @property {UIElement<HTMLDivElement, xmlEditorComponent>} xmlEditor - The codemirror-based xml editor with statusbar
 * @property {Spinner} spinner - A spinner/blocker to inform the user about long-running processes
 * @property {UIElement<SlDialog, dialogComponent>} dialog - A dialog to display messages or errors
 * @property {UIElement<SlDialog, promptEditorComponent>} promptEditor - A dialog to edit the prompt instructions
 * @property {UIElement<SlDialog, extractionOptionsDialog>} extractionOptions - A dialog to choose extraction options
 * @property {UIElement<SlDialog, infoDialogComponent>} infoDialog - A dialog to display information and help
 * @property {UIElement<SlDialog, loginDialog>} loginDialog - A dialog for login
 * @property {UIElement<SlDialog, teiWizardDialogComponent>} teiWizardDialog - TEI Wizard dialog (added by tei-wizard plugin)
 */




/**
 * This variable provides access to the top-level UI components through named properties.
 * Each property gives direct access to the component and its navigation hierarchy.
 * @type {namedElementsTree}
 */
let ui = /** @type {namedElementsTree} */(/** @type {unknown} */(null));

/**
 * Generates UI elements from templates in the 'app/src/templates' folder or from
 * literal hmtl strings, which must start with "<". If a parentNode is given,
 * the elements are appended to it and the `ui` object is updated automatically.
 * If no parentNode is given, the generated nodes are returned as an array, and you
 * need to call `updateUi()` manually to update the `ui` object.
 * @param {string} htmlOrFile A literal html string or the name of a file in the 'app/src/templates/' folder
 * @param {Element|Document|null} [parentNode] 
 *    If given, appends the generated nodes as children to the parentNode. 
 * @returns {Promise<ChildNode[]>} All the created nodes in an array
 */
async function createHtmlElements(htmlOrFile, parentNode=null){
  let html
  if (htmlOrFile.trim()[0]==='<') {
    // interpret as literal html
    html = htmlOrFile.trim()
  } else {
    // treat as path
    const path = '/src/templates/' + htmlOrFile
    console.log('Loading HTML from', path)
    html = await (await fetch(path)).text()
  }
  const div = document.createElement('div')
  div.innerHTML = html.trim()
  const nodes = Array.from(div.childNodes)
  // if a parent node has been given, add nodes to it and update the `ui` object
  if (parentNode instanceof Element) {
    parentNode.append(...nodes)
    updateUi()
  } 
  // return the nodes as an array
  return nodes
}

/**
 * Updates the UI structure
 */
function updateUi() {
  ui = /** @type {namedElementsTree} */(/** @type {unknown} */(createNavigableElement(document)));
}

updateUi()

export {
  updateUi, createHtmlElements,
  SlDialog, SlButton, SlButtonGroup, SlTextarea, SlInput, SlOption, SlIcon, SlTooltip, SlMenu,
  SlMenuItem, SlSelect, SlDropdown, SlPopup, SlCheckbox, Spinner, SlDivider, SlSwitch
}
export default ui;
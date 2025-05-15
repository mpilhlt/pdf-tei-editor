import { accessNamedDescendentsAsProperties } from './modules/browser-utils.js';

import { Spinner } from './modules/spinner.js'
import { Switch } from './modules/switch.js';
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

/**
 * The UI of the application as a a typed JSDoc object structure, which can then be traversed via autocompletion. 
 * In this structure, each named DOM element encapsulates all named descencdent elements. Using a Proxy, the descendant 
 * elements can be accessed as virtual properties by the value of the name attribute.  
 */

/**
 * Import type definitions from plugins
 * 
 * @import {dialogComponent} from './plugins/dialog.js'
 * @import {promptEditorComponent} from './plugins/prompt-editor.js'
 * @import {floatingPanelComponent} from './plugins/floating-panel.js'
 * @import {documentActionsComponent, teiServicesComponents} from './plugins/services.js'
 * @import {extractionActionsComponent, extractionOptionsComponent} from './plugins/extraction.js'
 * @import {infoDialogComponent} from './plugins/info.js'
 */

/**
 * The top-level UI parts 
 * @typedef {object} namedElementsTree
 * @property {toolbarComponent} toolbar - The main toolbar
 * @property {floatingPanelComponent} floatingPanel - The floating panel with navigation buttons
 * @property {HTMLDivElement} pdfViewer - The PDFJS-based PDF viewer contained in an iFrame child node
 * @property {HTMLDivElement} xmlEditor - The codemirror-based xml editor
 * @property {Spinner} spinner - A spinner/blocker to inform the user about long-running processes and block the application while they are ongoing
 * @property {dialogComponent} dialog - A dialog to display messages or errors
 * @property {promptEditorComponent} promptEditor - A dialog to edit the prompt instructions
 * @property {extractionOptionsComponent} extractionOptions - A dialog to choose the options for the instructiopns
 * @property {infoDialogComponent} infoDialog - A dialog to display information and help on the application
 */

/**
 * The main toolbar with controls added by the plugins
 * @typedef {object} toolbarComponent
 * @property {HTMLDivElement} self
 * @property {SlSelect} pdf - The selectbox for the pdf document
 * @property {SlSelect} xml - The selectbox for the xml document
 * @property {SlSelect} diff - The selectbox for the xml-diff document
 * @property {documentActionsComponent} documentActions 
 * @property {teiServicesComponents} teiActions
 * @property {extractionActionsComponent} extractionActions
 */

/**
 * This variable represents the document node, which has the next-level named elements as virtual properties
 * with that name, which then have their named descendants as properties, etc. The property "self" is a reference to the node for the 
 * purpose of documenting the node type, which must be "object" for a `@typedef`.
 * @type{namedElementsTree}
 */
// @ts-ignore
let ui = null;

/**
 * Adds the given html to the target node
 * @param {string} html 
 * @param {Element|Document} targetNode
 * @returns {Element[]} All the created nodes in an array
 */
function appendHtml(html, targetNode=document.body){
  const div = document.createElement('div')
  div.innerHTML = html.trim()
  const result = []
  div.childNodes.forEach(childNode => {
    targetNode.append(childNode)
    result.push(childNode)
  })
  updateUi()
  return result
}

/**
 * Updates the UI structure
 */
function updateUi() {
  // @ts-ignore
  ui = accessNamedDescendentsAsProperties(document);
}

updateUi()

export {
  updateUi, appendHtml,
  SlDialog, SlButton, SlButtonGroup, SlTextarea, SlInput, SlOption, SlIcon, SlTooltip, SlMenu,
  SlMenuItem, SlSelect, SlDropdown, SlPopup, Spinner, Switch
}
export default ui;
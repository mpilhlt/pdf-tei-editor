import { accessNamedDescendentsAsProperties } from './modules/browser-utils.js';
export { Spinner } from '../modules/spinner.js'
export { SlSelect} from '@shoelace-style/shoelace/dist/components/select/select.js'
export { SlDialog} from '@shoelace-style/shoelace/dist/components/dialog/dialog.js'
export { SlButton} from '@shoelace-style/shoelace/dist/components/button/button.js'
export { SlButtonGroup } from '@shoelace-style/shoelace/dist/components/button-group/button-group.js'
export { SlTextarea } from '@shoelace-style/shoelace/dist/components/textarea/textarea.js'
export { SlInput } from '@shoelace-style/shoelace/dist/components/input/input.js'
export { SlSelect } from '@shoelace-style/shoelace/dist/components/select/select.js'
export { SlOption } from '@shoelace-style/shoelace/dist/components/option/option.js'
export { SlIcon } from '@shoelace-style/shoelace/dist/components/icon/icon.js'
export { SlTooltip } from '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'
export { SlMenu } from '@shoelace-style/shoelace/dist/components/menu/menu.js'
export { SlMenuItem } from '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js'


/**
 * The UI of the application as a a typed object structure, which can then be traversed. In this structure, 
 * each named DOM element encapsulates all named descencdent elements. Using a Proxy, the descendant 
 * elements can be accessed as virtual properties by the value of the name attribute.  
 */

/**
 * @typedef {object} namedElementsTree
 * @property {toolbarComponent} toolbar - The main toolbar
 * @property {floatingPanelComponent} floatingPanel - The floating panel with navigation buttons
 * @property {HTMLDivElement} pdfViewer
 * @property {HTMLDivElement} xmlEditor
 * @property {Spinner} spinner - (pdf-tei-editor plugin)
 * @property {SlDialog} dialog - (pdf-tei-editor plugin)
 */

/**
 * @typedef {object} toolbarComponent
 * @property {SlSelect} pdf - The selectbox for the pdf document
 * @property {SlSelect} xml - The selectbox for the xml document
 * @property {SlSelect} diff - The selectbox for the xml-diff document
 * @property {documentActionsComponent} documentActions 
 * @property {teiServicesComponents} teiActions
 * @property {extractionActionsComponent} extractionActions
 */

/**
 * @typedef {object} documentActionsComponent
 * @property {SlButton} saveXml 
 * @property {SlButton} duplicateXml
 * @property {SlButton} upload
 * @property {SlButton} download
 * @property {SlButton} deleteCurrent 
 * @property {SlButton} deleteCurrent 
 * @property {SlButton} deleteAll
 */

/**
 * @typedef {object} teiServicesComponents
 * @property {SlButton} validate 
 * @property {SlButton} teiWizard
 */

/**
 * @typedef {object} extractionActionsComponent
 * @property {SlButton} extractNew 
 * @property {SlButton} extractCurrent
 * @property {SlButton} editInstructions - added by prompt-editor plugin
 */

/**
 * @typedef {object} floatingPanelComponent
 * @property {HTMLButtonElement} xpath
 * @property {HTMLButtonElement} editXpath
 * @property {HTMLButtonElement} previousNode
 * @property {HTMLSpanElement} selectionIndex
 * @property {HTMLButtonElement} nextNode
 * @property {HTMLDivElement} markNodeButtons - children have class="node-status" and 'data-status' attribute
 * @property {Switch} switchAutoSearch
 * @property {diffNavigationComponent} diffNavigation
 * 
 */

/**
 * @typedef {object} diffNavigationComponent
 * @property {HTMLButtonElement} prevDiff
 * @property {HTMLButtonElement} nextDiff
 * @property {HTMLButtonElement} diffKeepAll
 * @property {HTMLButtonElement} diffChangeAll
 */


/**
 * @type{namedElementsTree}
 */
export default accessNamedDescendentsAsProperties(document);
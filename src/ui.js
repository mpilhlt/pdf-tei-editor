import { accessNamedDescendentsAsProperties } from './modules/browser-utils.js';

import { Spinner } from './modules/spinner.js' 
import SlDialog from '@shoelace-style/shoelace/dist/components/dialog/dialog.js'
import SlButton  from '@shoelace-style/shoelace/dist/components/button/button.js'
import SlButtonGroup from '@shoelace-style/shoelace/dist/components/button-group/button-group.js'
import SlTextarea from '@shoelace-style/shoelace/dist/components/textarea/textarea.js'
import SlInput from '@shoelace-style/shoelace/dist/components/input/input.js'
import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'
import SlIcon from '@shoelace-style/shoelace/dist/components/icon/icon.js'
import SlTooltip from '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'
import SlMenu from '@shoelace-style/shoelace/dist/components/menu/menu.js'
import SlMenuItem from '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js'

/**
 * The UI of the application as a a typed JSDoc object structure, which can then be traversed via autocompletion. 
 * In this structure, each named DOM element encapsulates all named descencdent elements. Using a Proxy, the descendant 
 * elements can be accessed as virtual properties by the value of the name attribute.  
 */

/**
 * Imports
 * @import {promptEditorComponent} from './plugins/prompt-editor.js'
 * @import {floatingPanelComponent} from './plugins/floating-panel.js'
 * @import {documentActionsComponent, teiServicesComponents, extractionActionsComponent} from './plugins/services.js'
 */

/**
 * The top-level UI parts 
 * @typedef {object} namedElementsTree
 * @property {toolbarComponent} toolbar - The main toolbar
 * @property {floatingPanelComponent} floatingPanel - The floating panel with navigation buttons
 * @property {HTMLDivElement} pdfViewer
 * @property {HTMLDivElement} xmlEditor
 * @property {Spinner} spinner 
 * @property {SlDialog} dialog 
 * @property {promptEditorComponent} promptEditor
 */

/**
 * The main toolbar
 * @typedef {object} toolbarComponent
 * @property {SlSelect} pdf - The selectbox for the pdf document
 * @property {SlSelect} xml - The selectbox for the xml document
 * @property {SlSelect} diff - The selectbox for the xml-diff document
 * @property {documentActionsComponent} documentActions 
 * @property {teiServicesComponents} teiActions
 * @property {extractionActionsComponent} extractionActions
 */

/**
 * This variable is Proxy for the document node, which has the next-level named elements as virtual properties
 * with that name, which are again a Proxy
 * @type{namedElementsTree}
 */
// @ts-ignore
const ui = accessNamedDescendentsAsProperties(document);

export { SlDialog, SlButton, SlButtonGroup, SlTextarea, SlInput, SlOption, SlIcon, SlTooltip, SlMenu, SlMenuItem, Spinner }
export default ui;
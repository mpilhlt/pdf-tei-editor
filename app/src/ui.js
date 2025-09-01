/**
 * The UI of the application as a typed object structure, which can then be traversed. 
 * In this structure, each named DOM element encapsulates all named descencdent elements.
 * This allows to access the elements via `ui.toolbar.pdf`, `ui.floatingPanel`, etc. The structure
 * is created by `createNavigableElement()`, which is called on the document
 * body at the end of this file. The JSDoc structure is used to document the UI elements and their 
 * properties and allow autocompletion in IDEs that support JSDoc.   
 */

import { createNavigableElement, createHtmlElements, registerTemplate, createFromTemplate, createSingleFromTemplate } from './modules/ui-system.js';

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
import SlDrawer from '@shoelace-style/shoelace/dist/components/drawer/drawer.js';
import SlTree from '@shoelace-style/shoelace/dist/components/tree/tree.js';
import SlTreeItem from '@shoelace-style/shoelace/dist/components/tree-item/tree-item.js';

// Import panels components early so web components are defined
import './modules/panels/index.js';

/**
 * Import type definitions from plugins
 * 
 * @import {ToolBar} from './modules/panels/tool-bar.js'
 * @import {dialogPart} from './plugins/dialog.js'
 * @import {promptEditorPart} from './plugins/prompt-editor.js'
 * @import {floatingPanelPart} from './plugins/floating-panel.js'
 * @import {documentActionsPart, teiServicesPart} from './plugins/services.js'
 * @import {extractionActionsPart, extractionOptionsDialog} from './plugins/extraction.js'
 * @import {infoDialogPart} from './plugins/info.js'
 * @import {loginDialog} from './plugins/authentication.js'
 * @import {pdfViewerPart} from './plugins/pdfviewer.js'
 * @import {xmlEditorPart} from './plugins/xmleditor.js'
 * @import {toolbarPart} from './plugins/toolbar.js'
 * @import {teiWizardDialogPart} from './plugins/tei-wizard.js'
 * @import {fileDrawerPart} from './plugins/file-selection-drawer.js'
 */

/**
 * Generic UI element type that combines DOM element properties with navigation properties
 * @template {Element} T - The DOM element type
 * @template {Record<string, any>} N - The navigation properties type
 * @typedef {T & N} UIPart
 */

/**
 * The top-level UI parts
 * @typedef {object} namedElementsTree
 * @property {UIPart<ToolBar, toolbarPart>} toolbar - The main toolbar
 * @property {UIPart<HTMLDivElement, floatingPanelPart>} floatingPanel - The floating panel with navigation buttons
 * @property {UIPart<HTMLDivElement, pdfViewerPart>} pdfViewer - The PDFJS-based PDF viewer with statusbar
 * @property {UIPart<HTMLDivElement, xmlEditorPart>} xmlEditor - The codemirror-based xml editor with statusbar
 * @property {Spinner} spinner - A spinner/blocker to inform the user about long-running processes
 * @property {UIPart<SlDialog, dialogPart>} dialog - A dialog to display messages or errors
 * @property {UIPart<SlDialog, promptEditorPart>} promptEditor - A dialog to edit the prompt instructions
 * @property {UIPart<SlDialog, extractionOptionsDialog>} extractionOptions - A dialog to choose extraction options
 * @property {UIPart<SlDialog, infoDialogPart>} infoDialog - A dialog to display information and help
 * @property {UIPart<SlDialog, loginDialog>} loginDialog - A dialog for login
 * @property {UIPart<SlDialog, teiWizardDialogPart>} teiWizardDialog - TEI Wizard dialog (added by tei-wizard plugin)
 * @property {UIPart<SlDrawer, fileDrawerPart>} fileDrawer - File selection drawer (added by file-selection-drawer plugin)
 */

/**
 * This variable provides access to the top-level UI parts through named properties.
 * Each property gives direct access to the part and its navigation hierarchy.
 * @type {namedElementsTree}
 */
let ui = /** @type {namedElementsTree} */(/** @type {unknown} */(null));


/**
 * Updates the UI structure
 */
function updateUi() {
  ui = /** @type {namedElementsTree} */(/** @type {unknown} */(createNavigableElement(document)));
}

updateUi()

export {
  updateUi, createHtmlElements, registerTemplate, createFromTemplate, createSingleFromTemplate,
  SlDialog, SlButton, SlButtonGroup, SlTextarea, SlInput, SlOption, SlIcon, SlTooltip, SlMenu,
  SlMenuItem, SlSelect, SlDropdown, SlPopup, SlCheckbox, Spinner, SlDivider, SlSwitch, SlDrawer, SlTree, SlTreeItem
}
export default ui;

// @ts-ignore
window.ui = ui; // for debugging

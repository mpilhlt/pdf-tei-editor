/**
 * Plugin imports and configuration
 * 
 * This file contains all plugin imports and exports for the PDF-TEI-Editor application.
 * It provides the plugins array for registration and individual plugin APIs for backward compatibility.
 */

/**
 * @import {Plugin} from './modules/plugin-base.js'
 * @import {PluginConfig} from './modules/plugin-manager.js'
 */

// class-based plugins
import AuthenticationPlugin from './plugins/authentication.js'
import BackendPluginsPlugin from './plugins/backend-plugins.js'
import FiledataPlugin from './plugins/filedata.js'
import LoggerPlugin from './plugins/logger.js'
import { logLevel} from './plugins/logger.js'
import UserAccountPlugin from './plugins/user-account.js'

// legacy plugins
import { plugin as configPlugin, api as config } from './plugins/config.js'
import { plugin as urlHashStatePlugin, api as urlHash } from './plugins/url-hash-state.js'
import { plugin as ssePlugin, api as sse} from './plugins/sse.js'
import { plugin as dialogPlugin, api as dialog } from './plugins/dialog.js'
import { plugin as pdfViewerPlugin, api as pdfViewer } from './plugins/pdfviewer.js'
import { plugin as xmlEditorPlugin, api as xmlEditor } from './plugins/xmleditor.js'
import { plugin as validationPlugin, api as validation } from './plugins/tei-validation.js'
import { plugin as clientPlugin, api as client } from './plugins/client.js'
import { plugin as fileselectionPlugin, api as fileselection } from './plugins/file-selection.js'
import { plugin as fileSelectionDrawerPlugin, api as fileSelectionDrawer } from './plugins/file-selection-drawer.js'
import { plugin as extractionPlugin, api as extraction } from './plugins/extraction.js'
import { plugin as documentActionsPlugin, api as documentActions } from './plugins/document-actions.js'
import { plugin as servicesPlugin, api as services } from './plugins/services.js'
import { plugin as floatingPanelPlugin, api as floatingPanel } from './plugins/floating-panel.js'
import { plugin as promptEditorPlugin, api as promptEditor } from './plugins/prompt-editor.js'
import { plugin as teiWizardPlugin } from './plugins/tei-wizard.js'
import { plugin as infoPlugin, api as appInfo } from './plugins/info.js'
import { plugin as moveFilesPlugin } from './plugins/move-files.js'
import { plugin as startPlugin } from './plugins/start.js'
import { plugin as toolbarPlugin } from './plugins/toolbar.js'
import { plugin as syncPlugin, api as sync } from './plugins/sync.js'
import { plugin as accessControlPlugin, api as accessControl } from './plugins/access-control.js'
import { plugin as heartbeatPlugin, api as heartbeat } from './plugins/heartbeat.js'
import { plugin as rbacManagerPlugin } from './plugins/rbac-manager.js'
import { plugin as configEditorPlugin } from './plugins/config-editor.js'

/** @type {Array<Plugin|PluginConfig>} */
const plugins = [
  // class-based
  AuthenticationPlugin,
  BackendPluginsPlugin,
  LoggerPlugin,

  // modules with config object
  urlHashStatePlugin,
  clientPlugin,
  configPlugin,
  dialogPlugin,
  toolbarPlugin,

  // Toolbar menu items (order matters - determines menu item order)
  infoPlugin,          // User Manual (first)
  FiledataPlugin,      // Garbage Collection (second, admin only)
  rbacManagerPlugin,   // Manage Users & Roles (third, admin only)
  configEditorPlugin,  // Configuration Editor (fourth, admin only)
  UserAccountPlugin,   // User Profile + Logout (last)

  // Other plugins
  pdfViewerPlugin,
  xmlEditorPlugin,
  fileselectionPlugin,
  fileSelectionDrawerPlugin,
  documentActionsPlugin,
  servicesPlugin,
  syncPlugin,
  extractionPlugin,
  floatingPanelPlugin,
  promptEditorPlugin,
  teiWizardPlugin,
  validationPlugin,
  moveFilesPlugin,
  ssePlugin,
  accessControlPlugin,
  heartbeatPlugin,
  startPlugin
]

// Export plugins array as default
export default plugins

// Export individual plugin APIs for backward compatibility
export {
  // class-based plugins
  AuthenticationPlugin,
  UserAccountPlugin,
  LoggerPlugin,

  // legacy plugin APIs
  logLevel,
  config,
  urlHash,
  sse,
  dialog, 
  pdfViewer, 
  xmlEditor, 
  validation,
  client,
  fileselection,
  fileSelectionDrawer,
  extraction,
  documentActions,
  services,
  floatingPanel, 
  promptEditor,
  appInfo,
  sync, 
  accessControl, 
  heartbeat
}

// Export FiledataPlugin class for getInstance() access
export { FiledataPlugin };
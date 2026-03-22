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

// class-based plugins (imported via plugin-registry.js)
import {
  AuthenticationPlugin,
  BackendPluginsPlugin,
  ClientPlugin,
  ConfigPlugin,
  DialogPlugin,
  FiledataPlugin,
  FileSelectionDrawerPlugin,
  HeartbeatPlugin,
  HelpPlugin,
  LoggerPlugin,
  ProgressPlugin,
  SsePlugin,
  TeiValidationPlugin,
  UrlHashStatePlugin,
  UserAccountPlugin,
  XslViewerPlugin,
} from './plugin-registry.js'
import { logLevel } from './plugins/logger.js'

// object-based plugins
import { api as config } from './plugins/config.js'
import { api as dialog } from './plugins/dialog.js'
import { plugin as pdfViewerPlugin, api as pdfViewer } from './plugins/pdfviewer.js'
import { plugin as xmlEditorPlugin, api as xmlEditor } from './plugins/xmleditor.js'
import { api as validation } from './plugins/tei-validation.js'
import { api as client } from './plugins/client.js'
import { plugin as fileselectionPlugin, api as fileselection } from './plugins/file-selection.js'
import { api as fileSelectionDrawer } from './plugins/file-selection-drawer.js'
import { plugin as extractionPlugin, api as extraction } from './plugins/extraction.js'
import { plugin as documentActionsPlugin, api as documentActions } from './plugins/document-actions.js'
import { plugin as servicesPlugin, api as services } from './plugins/services.js'
import { plugin as promptEditorPlugin, api as promptEditor } from './plugins/prompt-editor.js'
import { plugin as teiWizardPlugin } from './plugins/tei-wizard.js'
import { plugin as teiToolsPlugin } from './plugins/tei-tools.js'
import { plugin as infoPlugin, api as appInfo } from './plugins/info.js'
import { plugin as annotationGuidePlugin, api as annotationGuide } from './plugins/annotation-guide.js'
import { plugin as moveFilesPlugin } from './plugins/move-files.js'
import { plugin as startPlugin } from './plugins/start.js'
import { plugin as toolbarPlugin } from './plugins/toolbar.js'
import { plugin as toolsPlugin } from './plugins/tools.js'
import { plugin as accessControlPlugin, api as accessControl } from './plugins/access-control.js'
import { plugin as rbacManagerPlugin } from './plugins/rbac-manager.js'
import { plugin as configEditorPlugin } from './plugins/config-editor.js'

/** @type {Array<Plugin|PluginConfig>} */
const plugins = [
  // class-based
  AuthenticationPlugin,
  BackendPluginsPlugin,
  LoggerPlugin,

  // modules with config object
  UrlHashStatePlugin,
  ClientPlugin,
  ConfigPlugin,
  DialogPlugin,
  toolbarPlugin,
  toolsPlugin,

  // Help plugin (must come before info plugin which depends on it)
  HelpPlugin,

  // Toolbar menu items (order matters - determines menu item order)
  infoPlugin,          // User Manual (first)
  annotationGuidePlugin, // Annotation Guide
  UserAccountPlugin,   // User Profile + Logout (last)

  // Tools menu — Administration section (admin only, order determines item order)
  FiledataPlugin,      // Garbage Collection
  rbacManagerPlugin,   // Manage Users & Roles
  configEditorPlugin,  // Configuration Editor

  // Other plugins
  pdfViewerPlugin,
  xmlEditorPlugin,
  XslViewerPlugin,
  teiToolsPlugin,
  fileselectionPlugin,
  FileSelectionDrawerPlugin,
  documentActionsPlugin,
  servicesPlugin,
  extractionPlugin,
  promptEditorPlugin,
  teiWizardPlugin,
  TeiValidationPlugin,
  moveFilesPlugin,
  SsePlugin,
  ProgressPlugin,
  accessControlPlugin,
  HeartbeatPlugin,
  startPlugin
]

// Export plugins array as default
export default plugins

// Export individual plugin APIs for backward compatibility
export {
  // class-based plugins
  AuthenticationPlugin,
  HelpPlugin,
  UserAccountPlugin,
  LoggerPlugin,

  // object plugin APIs
  logLevel,
  config,
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
  promptEditor,
  appInfo,
  annotationGuide,
  accessControl
}

// Export Plugin classes for getInstance() access
export { FiledataPlugin, HeartbeatPlugin, ProgressPlugin, SsePlugin, UrlHashStatePlugin, XslViewerPlugin };
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
  AccessControlPlugin,
  AnnotationGuidePlugin,
  AuthenticationPlugin,
  BackendPluginsPlugin,
  ClientPlugin,
  ConfigEditorPlugin,
  ConfigPlugin,
  DialogPlugin,
  DocumentActionsPlugin,
  ExtractionPlugin,
  FiledataPlugin,
  FileSelectionDrawerPlugin,
  HeartbeatPlugin,
  InfoPlugin,
  MoveFilesPlugin,
  PdfViewerPlugin,
  RbacManagerPlugin,
  TeiToolsPlugin,
  TeiWizardPlugin,
  ToolbarPlugin,
  ToolsPlugin,
  XmlEditorPlugin,
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
import { api as pdfViewer } from './plugins/pdfviewer.js'
import { api as xmlEditor } from './plugins/xmleditor.js'
import { api as validation } from './plugins/tei-validation.js'
import { api as client } from './plugins/client.js'
import { plugin as fileselectionPlugin, api as fileselection } from './plugins/file-selection.js'
import { api as extraction } from './plugins/extraction.js'
import { plugin as servicesPlugin, api as services } from './plugins/services.js'
import PromptEditorPlugin from './plugins/prompt-editor.js'
import { plugin as startPlugin } from './plugins/start.js'
import { api as accessControl } from './plugins/access-control.js'

/** @type {Array<Plugin|PluginConfig>} */
const plugins = [
  // class-based
  AuthenticationPlugin,
  BackendPluginsPlugin,
  LoggerPlugin,
  UrlHashStatePlugin,
  ClientPlugin,
  ConfigPlugin,
  DialogPlugin,
  ToolbarPlugin,
  ToolsPlugin,

  // Help plugin (must come before info plugin which depends on it)
  HelpPlugin,

  // Toolbar menu items (order matters - determines menu item order)
  UserAccountPlugin,   // User Profile + Logout (last)

  // Tools menu — Administration section (admin only, order determines item order)
  FiledataPlugin,      // Garbage Collection
  RbacManagerPlugin,   // Manage Users & Roles
  ConfigEditorPlugin,  // Configuration Editor

  // Other plugins
  InfoPlugin,          // User Manual (first)
  AnnotationGuidePlugin, // Annotation Guide
  PdfViewerPlugin,
  XmlEditorPlugin,
  XslViewerPlugin,
  TeiToolsPlugin,
  fileselectionPlugin,
  FileSelectionDrawerPlugin,
  DocumentActionsPlugin,
  servicesPlugin,
  ExtractionPlugin,
  PromptEditorPlugin,
  TeiWizardPlugin,
  TeiValidationPlugin,
  MoveFilesPlugin,
  SsePlugin,
  ProgressPlugin,
  AccessControlPlugin,
  HeartbeatPlugin,
  startPlugin
]

// Export plugins array as default
export default plugins

// Export individual plugin APIs for backward compatibility
export {
  // class-based plugins - needed where?
  AuthenticationPlugin,
  HelpPlugin,
  LoggerPlugin,

  // needed by sandbox modules
  SsePlugin, 
  XslViewerPlugin,

  // object plugin APIs
  logLevel,
  config,
  dialog,
  pdfViewer,
  xmlEditor,
  validation,
  client,
  fileselection,
  extraction,
  services,
  accessControl
}

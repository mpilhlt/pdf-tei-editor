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
  FileSelectionPlugin,
  HeartbeatPlugin,
  InfoPlugin,
  MoveFilesPlugin,
  PdfViewerPlugin,
  PromptEditorPlugin,
  RbacManagerPlugin,
  ServicesPlugin,
  StartPlugin,
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
  FileSelectionPlugin,
  FileSelectionDrawerPlugin,
  DocumentActionsPlugin,
  ServicesPlugin,
  ExtractionPlugin,
  ToolsPlugin,
  PromptEditorPlugin,
  TeiWizardPlugin,
  TeiValidationPlugin,
  MoveFilesPlugin,
  SsePlugin,
  ProgressPlugin,
  AccessControlPlugin,
  HeartbeatPlugin,
  StartPlugin
]

// Export plugins array as default
export default plugins

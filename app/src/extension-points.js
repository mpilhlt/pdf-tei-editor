/**
 * The extension points that plugins can implement.
 *
 * Extension points are named hooks that the plugin system uses to call plugin methods
 * in dependency order. Each value is the string path used when invoking via PluginManager.invoke().
 */
const extensionPoints = {
  /**
   * Install the plugin. Called once during application startup.
   * Function signature: (state: ApplicationState) => void
   */
  install: "install",

  /**
   * Invoked when the program starts. Called after all plugins are installed.
   * Function signature: (state: ApplicationState) => void
   */
  start: "start",

  /**
   * Invoked when the application startup is complete and ready for user interaction.
   * This fires after start() has finished, allowing plugins to defer non-critical
   * initialization that would otherwise block the initial page load.
   * Function signature: () => void
   */
  ready: "ready",

  /**
   * Invoked when the application is shutting down (beforeunload).
   * Function signature: () => void
   */
  shutdown: "shutdown",

  /**
   * Logging extension points
   */
  log: {
    /** Function signature: ({level: Number}) => void */
    setLogLevel: "log.setLogLevel",

    /** Function signature: ({message: string}) => void */
    debug: "log.debug",

    /** Function signature: ({message: string}) => void */
    info: "log.info",

    /** Function signature: ({message: string}) => void */
    warn: "log.warn",

    /** Function signature: ({message: string}) => void */
    critical: "log.critical"
  },
  state: {
    /**
     * Allows all plugins to react to application state changes (legacy).
     * Function signature: (state: ApplicationState) => void
     * @deprecated Use "onStateUpdate" instead
     */
    update: "state.update",

    /**
     * Internal state update for Plugin class instances (silent, no side effects).
     * Function signature: (state: ApplicationState) => void
     */
    updateInternal: "updateInternalState",

    /**
     * State change notification. Receives only the changed keys.
     * Function signature: (changedKeys: string[], state: ApplicationState) => void
     */
    onStateUpdate: "onStateUpdate",
  },
  validation: {
    /**
     * Triggers validation.
     * Function signature: ({type:string, text:string}) => Diagnostic[]
     */
    validate: "validation.validate",
    /**
     * Configures validation behaviour.
     * Function signature: ({mode:string=auto}) => void. Supported modes: "auto", "manual".
     */
    configure: "validation.configure",
    /**
     * Informs plugins that a validation is in progress and they must wait before certain actions.
     * Function signature: (promise: Promise<Diagnostic[]>) => void
     */
    inProgress: "validation.inProgress",

    /**
     * Invoked with the diagnostics of the completed validation.
     * Function signature: (diagnostics: Diagnostic[]) => Promise<void>
     */
    result: "validation.result"
  },
  filedata: {
    /** (options:{refresh:Boolean}) => Promise<ApplicationState> */
    reload: "filedata.reload",
    saveXml: "filedata.saveXml",
    /** (loading: boolean) => void — signal that file data is being loaded */
    loading: "filedata.loading"
  },
  export_formats: {
    /**
     * Get additional export formats from plugins.
     * Function signature: () => Array<{id: string, label: string, url: string}>
     */
    formats: "export_formats"
  },
  sync: {
    /**
     * Trigger file synchronization. Returns SyncResult or {skipped:true} if no sync plugin is active.
     * Function signature: (state: ApplicationState) => Promise<SyncResult>
     */
    syncFiles: "sync.syncFiles"
  },
  backendPlugins: {
    /** Execute a backend plugin by ID. Function signature: (pluginId, endpointName, params) => void */
    execute: 'backend-plugins.execute'
  },
  toolbar: {
    /**
     * Contribute static items to the main toolbar.
     * Called by ToolbarPlugin.start() on all plugins that declare this extension point.
     * Function signature: () => Array<{element: HTMLElement, priority?: number, position?: 'left'|'center'|'right'}>
     */
    contentItems: "toolbar.contentItems",
    /**
     * Contribute static items to the main toolbar dropdown menu.
     * Called by ToolbarPlugin.start() on all plugins that declare this extension point.
     * Function signature: () => Array<{element: HTMLElement}>
     */
    menuItems: "toolbar.menuItems",
  }
}

export default extensionPoints

/**
 * The extension endpoints that the plugins can implement
 */
const endpoints = {
  /**
   * This endpoint serves to install plugins. Plugins can modify the application state.
   * Function signature: (state: ApplicationState) => ApplicationState
   */
  install: "install",

  /**
   * Invoked when the program starts. Plugins can modify the application state.
   * Function signature: (state: ApplicationState) => ApplicationState
   */
  start: "start",

  /**
   * Invoked when the application is shutting down (beforeunload).
   * Function signature: () => void
   */
  shutdown: "shutdown",

  /**
   * Logging endpoints
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
     * This endpoint allows all plugins to react to application state changes (legacy)
     * Function signature: (state: ApplicationState) => ApplicationState
     * @deprecated Use "onStateUpdate" instead
     */
    update: "state.update",
    
    /**
     * Internal state update for Plugin class instances (new system)
     * Function signature: (state: ApplicationState) => void
     */
    updateInternal: "updateInternalState",
    
    /**
     * State change notification for Plugin class instances (new system)
     * Function signature: (changedKeys: string[], state: ApplicationState) => void
     */
    onStateUpdate: "onStateUpdate",

  },
  validation: {
    /**
     * Enpoint that triggers validation 
     * Function signature: ({type:string, text:string}) => Diagnostic. Currently, only `type` "xml" is supportet
     */
    validate: "validation.validate",
    /**
     * Endpoint to configure validation
     * Function signature: ({mode:string=auto}) => void . Supported modes: "auto", "manual". 
     */
    configure:"validation.configure",
    /**
     * Endpoint to inform implementing plugins that a validation is in progress and that they must wait for it to
     * end to perform certain actions
     * Function signature: (promise:Promise<Diagnostics[]>) => void - Invoked with a promise that resolves when validation is done
     */
    inProgress: "validation.inProgress",

    /**
     * Endpoint that will be invoked with the diagnostics of the completed validation
     * Function signature: (diagnostics: Diagnostics[]) => Promise<void> 
     */
    result: "validation.result"
  }
}

export default endpoints
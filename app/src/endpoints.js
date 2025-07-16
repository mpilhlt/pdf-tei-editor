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
    critical: "log.fatal"
  },
  state: {
    /**
     * This endpoint allows all plugins to react to application state changes
     * Function signature: (state: ApplicationState) => ApplicationState
     */
    update: "state.update"
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
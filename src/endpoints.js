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
  tei: {
    /**
     * Endpoint that receives an TEI XML string, responding plugins can apply corrections and enhancements
     * Function signature: (xml: string) => string
     */
    enhancement: "tei.enhancement"
  }
}

export default endpoints
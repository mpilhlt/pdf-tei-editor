/**
 * The extension endpoints that the plugins can implement
 */
const endpoints = {
  /**
   * This endpoint serves to install plugins. Plugins can modify the application state.
   * @type {(state: ApplicationState) => ApplicationState}
   */
  install: "install",

  /**
   * Invoked when the program starts. Plugins can modify the application state.
   * @type {(state: ApplicationState) => ApplicationState}
   */
  start: "start",

  /**
   * Logging endpoints
   */
  log: {
    /**
     * @type {({level: Number}) => void}
     */
    setLogLevel: "log.setLogLevel",
    /**
     * @type {({message: string}) => void}
     */
    debug: "log.debug",
    /**
     * @type {({message: string}) => void}
     */
    info: "log.info",
    /**
     * @type {({message: string}) => void}
     */
    warn: "log.warn",
    /**
     * @type {({message: string}) => void}
     */
    fatal: "log.fatal"
  },
  state: {
    /**
     * This endpoint allows all plugins to react to application state changes
     * @type {(state: ApplicationState) => ApplicationState}
     */
    update: "state.update"
  },
  tei: {
    /**
     * Endpoint that receives an TEI XML string, responding plugins can apply corrections and enhancements
     * @type {(xml: string) => string}
     */
    enhancement: "tei.enhancement"
  }
}

export default endpoints
/**
 *test the plugin system 
 */

// name of the component
const name = "logger-dummy"

function debug({message}) {
  console.log(`Hello from dummy logger: ${message}`)
}

/**
 * component plugin
 */
const plugin = {
  name,
  install: () => console.log("Dummy logger installed."),
  log: {
    setLogLevel: () => {}, 
    debug,
    info: () => {}, 
    warn: () => {}, 
    fatal: () => {}
  }
}

export { plugin }
export default plugin

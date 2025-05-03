//import '@shoelace-style/shoelace/dist/components/select/select.js';

import { App } from '../modules/app.js'
import { $ } from '../modules/browser-utils.js'

const commandBar = $('#command-bar')

export const commandBarComponent = {
    add: element => commandBar.appendChild(element),
    remove: element => commandBar.parentElement.removeChild(element)
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {App} app The main application
 */
function start(app) {
  console.log("Dialog plugin installed.")
  app.registerComponent('command-bar', commandBarComponent, 'commandbar')
}

export const commandBarPlugin = {
    name: "command-bar",
    app: { start }
}

export default commandBarPlugin

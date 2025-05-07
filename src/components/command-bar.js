/**
 * This implements a horizonal menu/button bar onto which other components can add control elements
 */
import { PdfTeiEditor } from '../app.js'
import { getNameMap } from '../modules/browser-utils.js';

const componentId = "command-bar"

/**
 * component API
 */
const cmp = {
  add,
  addAt,
  addBefore,
  getByName,
  onClick,
  controls: () => getNameMap(document.getElementById(componentId), ['sl-icon'])
};

/**
 * component plugin
 */
const commandBarPlugin = {
  name: componentId,
  install
}

export { cmp as commandBarComponent, commandBarPlugin }
export default commandBarPlugin

//
// implementations
//

// component node 
const componentNode = document.getElementById(componentId)

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent(componentId, cmp, "commandbar")
  app.logger.info("Menubar component installed")
}

/**
 * Add an element, optionally with a name attribute
 * @param {Element} element
 * @param {string?} name
 */
function add(element, name) {
  if (name) {
    element.name = name;
  }
  componentNode.appendChild(element);
}

/**
 * Add an element at the specific index
 * @param {Element} element
 * @param {Number} index
 * @param {string} name
 */
function addAt(element, index, name) {
  if (name) {
    element.name = name;
  }
  componentNode.insertBefore(element, componentNode.childNodes[index]);
}

/**
 * Add the given element before the one with the given name
 * @param {Element} element The element to add
 * @param {string} name The name of the element before which the given element should be added
 */
function addBefore(element, name) {
  componentNode.insertBefore(element, getByName(name));
}

/**
 * Returns the child element of that name
 * @param {string} name The name of the child element
 * @returns {Element}
 */
function getByName(name) {
  const namedElems = componentNode.querySelectorAll(`[name="${name}"]:not(sl-icon)`);
  if (namedElems.length === 1) {
    return namedElems[0];
  }
  throw new Error(`No or more than one child element with the name "${name}"`);
}

/**
 * Attaches a click event handler to a named subelement of the component
 * @param {string} name The name of the element
 * @param {Function} handler The function to call when the element is clicked
 */
function onClick(name, handler) {
  getByName(name).addEventListener('click', handler);
}


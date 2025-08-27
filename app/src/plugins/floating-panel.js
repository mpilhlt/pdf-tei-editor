/** 
 * @import { ApplicationState } from '../app.js'
 * @import { Switch } from '../modules/switch.js'
 * @import { UIPart } from '../ui.js'
 */
import { updateState, client, logger, services, dialog, xmlEditor, config } from '../app.js'
import { $$, isValidXPath } from '../modules/browser-utils.js'
import { parseXPath } from '../modules/utils.js'
import { createHtmlElements, updateUi } from '../ui.js'
import ui from '../ui.js'

/**
 * plugin API
 */
const api = {
  show: () => ui.floatingPanel.classList.remove("hidden"),
  hide: () => ui.floatingPanel.classList.add("hidden"),
}

/**
 * component plugin
 */
const plugin = {
  name: "floating-panel",
  deps: ['config'],
  install,
  state: { update }
}

export { api, plugin }
export default plugin

//
// implementations
//

// UI elements

/**
 * Floating panel
 * @typedef {object} floatingPanelPart
 * @property {HTMLSelectElement} xpath
 * @property {HTMLButtonElement} editXpath
 * @property {HTMLButtonElement} previousNode
 * @property {HTMLSpanElement} selectionIndex
 * @property {HTMLButtonElement} nextNode
 * @property {HTMLDivElement} markNodeButtons - children have class="node-status" and 'data-status' attribute
 * @property {UIPart<HTMLDivElement, diffNavigationPart>} diffNavigation
 * 
 */
/** @type {ChildNode[]} */
const floatingPanelControls = await createHtmlElements('floating-panel.html')

/**
 * Diff Navigation navigation properties
 * @typedef {object} diffNavigationPart
 * @property {HTMLButtonElement} prevDiff
 * @property {HTMLButtonElement} nextDiff
 * @property {HTMLButtonElement} diffKeepAll
 * @property {HTMLButtonElement} diffChangeAll
 */


const pluginId = "floating-panel"


/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  document.body.append(...floatingPanelControls)
  updateUi()

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener([`#${pluginId}`, '.cm-panels']);

  // make navigation draggable
  makeDraggable(ui.floatingPanel)

  // populate the xpath selectbox
  const xp = ui.floatingPanel.xpath

  // Clear existing options
  xp.innerHTML = '';

  // Populate select box with options

  /**
   * @type {{value:string, label:string}[]}
   */
  const selectBoxData = await config.get("navigation.xpath.list")
  selectBoxData.forEach(item => {
    const option = document.createElement('option');
    option.value = item.value || ''
    option.text = item.label
    option.disabled = item.value === null
    xp.appendChild(option);
  });

  // listen for changes in the selectbox
  xp.addEventListener('change', async () => {
    await updateState(state, { xpath: xp.value })
  });

  // button to edit the xpath manually
  ui.floatingPanel.editXpath.addEventListener('click', () => onEditXpath(state))

  // setup event handlers
  const fp = ui.floatingPanel

  // node navigation
  fp.previousNode.addEventListener('click', () => changeNodeIndex(state, -1));
  fp.nextNode.addEventListener('click', () => changeNodeIndex(state, +1));

  // diff navigation
  fp.diffNavigation.prevDiff.addEventListener('click', () => xmlEditor.goToPreviousDiff())
  fp.diffNavigation.nextDiff.addEventListener('click', () => xmlEditor.goToNextDiff())
  fp.diffNavigation.diffKeepAll.addEventListener('click', () => {
    xmlEditor.rejectAllDiffs()
    services.removeMergeView(state)
  })
  fp.diffNavigation.diffChangeAll.addEventListener('click', () => {
    xmlEditor.acceptAllDiffs()
    services.removeMergeView(state)
  })

  fp.selectionIndex.addEventListener('click', onClickSelectionIndex) // allow to input node index

  // configure "status" buttons
  $$('.node-status').forEach(btn => btn.addEventListener('click', async evt => {
    if (!state.xpath) {
      return
    }
    xmlEditor.selectByXpath(state.xpath)
    if (xmlEditor.selectedNode) {
      $$('.node-status').forEach(btn => btn.disabled = true)
      await xmlEditor.setNodeStatus(xmlEditor.selectedNode, evt.target.dataset.status)
      $$('.node-status').forEach(btn => btn.disabled = false)
    }
  }))
}

/**
 * Reacts to application state changes
 * @param {ApplicationState} state 
 */
async function update(state) {
  //console.warn("update", plugin.name, state)
  // show the xpath selector
  if (state.xpath) {
    let { index, pathBeforePredicates, nonIndexPredicates } = parseXPath(state.xpath)

    const optionValues = Array.from(ui.floatingPanel.xpath.options).map(node => node.value)
    const nonIndexedPath = pathBeforePredicates + nonIndexPredicates
    const foundAtIndex = optionValues.indexOf(nonIndexedPath)
    if (foundAtIndex >= 0) {
      // this sets the xpath selectbox to one of the existing values
      ui.floatingPanel.xpath.selectedIndex = foundAtIndex
    } else {
      // the value does not exist, save it to the last option
      let lastIdx = ui.floatingPanel.xpath.options.length - 1
      ui.floatingPanel.xpath.options[lastIdx].value = state.xpath
      ui.floatingPanel.xpath.options[lastIdx].text = `Custom: ${state.xpath}`
      ui.floatingPanel.xpath.options[lastIdx].disabled = false
    }
    // update counter with index and size
    xmlEditor.whenReady().then(() => updateCounter(nonIndexedPath, index))
  }

  // configure node status buttons
  ui.floatingPanel.markNodeButtons.querySelectorAll("button").forEach(btn => btn.disabled = !Boolean(state.xpath))

  // configure diff navigation buttons
  ui.floatingPanel.diffNavigation.querySelectorAll("button").forEach(node => {
    node.disabled = !state.diff || state.diff === state.xml
  })
  //console.warn(plugin.name,"done")
}

/**
 * Given an xpath and an index, displays the index and the number of occurrences of the 
 * xpath in the xml document. If none can be found, the index is displayed as 0.
 * @param {string} xpath The xpath that will be counted
 * @param {Number | null} index The index or null if the result set is empty
 */
function updateCounter(xpath, index) {
  let size;
  try {
    size = xmlEditor.countDomNodesByXpath(xpath)
  } catch (e) {
    logger.warn('Cannot update counter: ' + e.message)
    size = 0
  }
  index = index || 1
  ui.floatingPanel.selectionIndex.textContent = `(${size > 0 ? index : 0}/${size})`
  ui.floatingPanel.nextNode.disabled = ui.floatingPanel.previousNode.disabled = size < 2;
}

async function changeNodeIndex(state, delta) {
  if (isNaN(delta)) {
    throw new TypeError("Second argument must be a number")
  }
  const normativeXpath = ui.floatingPanel.xpath.value
  let { index } = parseXPath(state.xpath)
  const size = xmlEditor.countDomNodesByXpath(normativeXpath)
  if (size < 2) return
  if (index === null) index = 1
  index += delta
  if (index < 0) index = size 
  if (index >= size) index = 1
  const xpath = normativeXpath + `[${index}]`
  await updateState(state, { xpath })
}


//
// Event handlers
//


/**
 * Called when the user clicks on the counter to enter the node index
 * @returns {void}
 */
function onClickSelectionIndex() {
  let index = prompt('Enter node index')
  if (!index) return;
  try {
    xmlEditor.selectByIndex(parseInt(index))
  } catch (error) {
    dialog.error(error.message)
  }
}

/**
 * Called when the custom Xpath button has been clicked on
 * @param {ApplicationState} state 
 */
async function onEditXpath(state) {
  const xmlDoc = xmlEditor.getXmlTree()
  if (xmlDoc === null) {
    return
  }
  const xp = ui.floatingPanel.xpath
  const custom = xp.options[xp.length - 1]
  const xpath = prompt("Enter custom xpath", custom.value)
  if (!xpath) return

  if (!isValidXPath(xpath, xmlDoc, xmlEditor.namespaceResolver)) {
    dialog.error(`'${xpath} is not a valid XPath expression'`)
  }

  custom.value = xpath
  custom.text = `Custom: ${xpath}`
  xp.selectedIndex = xp.length - 1
  xp.options[xp.length - 1].disabled = false
  await updateState(state, { xpath })
}

//
// helper functions
//

function addBringToForegroundListener(selectors) {
  document.addEventListener('click', function (event) {
    let elements = [];
    selectors.forEach(selector => elements = elements.concat(Array.from($$(selector))));
    let targetElement = elements.find(elem => elem.contains(event.target))
    if (targetElement) {
      let highestZIndex = elements.reduce((acc, elem) => {
        let zIndex = parseInt(window.getComputedStyle(elem).zIndex);
        return zIndex > acc ? zIndex : acc;
      }, 0);
      targetElement.style.zIndex = highestZIndex + 1;
    }
  });
}

function makeDraggable(element) {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;
  const { height, width } = window.getComputedStyle(element);
  element.style.cursor = 'grab';

  element.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = element.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    element.style.cursor = 'grabbing'; // Change cursor while dragging
    element.style.userSelect = 'none'; // Prevent text selection during drag
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    element.style.left = x + 'px';
    element.style.top = y + 'px';
    element.style.right = (x + width) + 'px';
    element.style.top = (y + height) + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    element.style.cursor = 'grab'; // Restore cursor after dragging
    element.style.userSelect = 'auto'; // Restore text selection
  });

  document.addEventListener('mouseleave', () => {
    if (isDragging) {
      isDragging = false;
      element.style.cursor = 'grab'; // Restore cursor after dragging
      element.style.userSelect = 'auto'; // Restore text selection
    }
  });
}

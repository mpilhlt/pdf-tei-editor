/** @import { ApplicationState } from '../app.js' */
import { invoke, updateState,  client, logger, services, dialog, xmlEditor } from '../app.js'
import { selectByValue, $$ } from '../modules/browser-utils.js'
import { parseXPath } from '../modules/utils.js'
import ui from '../ui.js'

// name of the component
const pluginId = "floating-panel"

/**
 * Floating panel
 * @typedef {object} floatingPanelComponent
 * @property {HTMLButtonElement} xpath
 * @property {HTMLButtonElement} editXpath
 * @property {HTMLButtonElement} previousNode
 * @property {HTMLSpanElement} selectionIndex
 * @property {HTMLButtonElement} nextNode
 * @property {HTMLDivElement} markNodeButtons - children have class="node-status" and 'data-status' attribute
 * @property {Switch} switchAutoSearch
 * @property {diffNavigationComponent} diffNavigation
 * 
 */

/**
 * Diff Navigation
 * @typedef {object} diffNavigationComponent
 * @property {HTMLButtonElement} prevDiff
 * @property {HTMLButtonElement} nextDiff
 * @property {HTMLButtonElement} diffKeepAll
 * @property {HTMLButtonElement} diffChangeAll
 */

// component htmnl
const html = `
  <style>
    #${pluginId} {
      position: absolute;
      display: flex;
      justify-content: space-between;
      flex-direction: column;
      gap: 10px;
      align-items: center;
      width: auto;
      height: auto;
      padding: 20px;
      top: 70vh;
      left: 100px;
      background-color: rgba(167, 158, 158, 0.8);
      border-radius: 10px;
      box-shadow: 0px 0px 10px rgba(0, 0, 0, 0.2);
    }

    #${pluginId}  * {
      font-size: small;
    }

    #${pluginId} > div {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #${pluginId} > div > * {
      display: inline;
    }      
  </style>
  <div id="${pluginId}" name="floatingPanel>
    <div>
      <span class="navigation-text">Navigate by</span>
      <select name="xpath"></select>
      <button name="editXpath">Custom XPath</button>
      <button name="previousNode" disabled>&lt;&lt;</button>
      <span name="selectionIndex" class="navigation-text"></span>
      <button name="nextNode" disabled>&gt;&gt;</button>
    </div>
    <div name="markNodeButtons">
      <span class="navigation-text">Mark node as</span>
      <button class="node-status" data-status="verified" disabled>Verified</button>
      <button class="node-status" data-status="unresolved" disabled>Unresolved</button>
      <button class="node-status" data-status="" disabled>Clear node</button>
      <!-- button class="node-status" data-status="comment" disabled>Add comment</button-->
    </div>
    <div>
      <custom-switch name="switchAutoSearch" label="Find node" label-on="On" label-off="off"></custom-switch>
      <span name="diffNavigation">
        <button name="prevDiff" disabled>Prev. Diff</button>
        <button name="nextDiff" disabled>Next Diff</button>
        <button name="diffKeepAll" disabled>Reject all changes</button>
        <button name="diffChangeAll" disabled>Accept all changes</button>
      </span>
    </div>
  </div>
`
const div = document.createElement("div")
div.innerHTML = html.trim()
document.body.appendChild(div)

/**
 * @type {HTMLDivElement}
 */
const panelNode = document.getElementById(pluginId)

/**
 * plugin API
 */
const api = {

  show: () => panelNode.classList.remove("hidden"),
  hide: () => panelNode.classList.add("hidden"),

  /**
   * Updates data such as select box options
   * @type {ApplicationState} state
   */
  update: (state) => populateui.toolbar.xml(state)
}

/**
 * component plugin
 */
const plugin = {
  name: pluginId,
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
 * Runs when the main app starts so the plugins can register the app components they supply
 * @type {ApplicationState} state
 */
async function install(state) {

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener([`#${pluginId}`, '.cm-panels']);

  // make navigation draggable
  makeDraggable(panelNode)

  // populate the xpath selectbox

  // Clear existing options
  ui.toolbar.xml.innerHTML = '';

  // Populate select box with options
  const selectBoxData = await client.getConfigValue("navigation.xpath.list")
  selectBoxData.forEach(item => {
    const option = document.createElement('option');
    option.value = item.value || ''
    option.text = item.label
    option.disabled = item.xpath === null
    ui.toolbar.xml.appendChild(option);
  });

  // listen for changes in the selectbox
  ui.toolbar.xml.addEventListener('change', async () => {
    await updateState(state, { xpath: ui.toolbar.xml.value })
  });

  // button to edit the xpath manually
  ui.floatingPanel.editXpath.addEventListener('click', () => {
    const custom = ui.toolbar.xml[ui.toolbar.xml.length - 1]
    const xpath = prompt("Enter custom xpath", custom.value)
    if (xpath && xpath.trim()) {
      custom.value = xpath
      custom.text = `Custom: ${xpath}`
      ui.toolbar.xml.selectedIndex = ui.toolbar.xml.length - 1
    }
  })

  // setup event handlers
  const fp = ui.floatingPanel
  fp.previousNode.addEventListener('click', () => xmlEditor.previousNode());
  fp.nextNode.addEventListener('click', () => xmlEditor.nextNode());
  fp.diffNavigation.prevDiff.addEventListener('click', () => xmlEditor.goToPreviousDiff())
  fp.diffNavigation.nextDiff.addEventListener('click', () => xmlEditor.goToNextDiff())
  fp.diffNavigation.diffKeepAll.addEventListener('click', () => {
    xmlEditor.rejectAllDiffs()
    services.removeMergeView()
  })
  fp.diffNavigation.diffChangeAll.addEventListener('click', () => {
    xmlEditor.acceptAllDiffs()
    services.removeMergeView()
  })
  fp.switchAutoSearch.addEventListener('change', onAutoSearchSwitchChange) // toggle search of node in the PDF
  fp.selectionIndex.addEventListener('click', onClickSelectionIndex) // allow to input node index

  // configure "status" buttons
  $$('.node-status').forEach(btn => btn.addEventListener('click', evt => {
    xmlEditor.setNodeStatus(xmlEditor.selectedNode, evt.target.dataset.status)
  }))

  // update selectbox when corresponding app state changes
  logger.info("Floating panel plugin installed.")
}

/**
 * Reacts to application state changes
 * @param {ApplicationState} state 
 */
async function update(state) {

  // show the xpath selector
  if (state.xpath) {
    let { index, pathBeforePredicates } = parseXPath(xpath)

    const optionValues = Array.from(ui.floatingPanel.xpath.childNodes).map(node => node.value)
    if (pathBeforePredicates in optionValues) {
      // this sets the xpath selectbox to one of the existing values
      ui.floatingPanel.xpath = pathBeforePredicates
    } else {
      // the value does not exist, save it to the last option
      let lastIdx = ui.floatingPanel.xpath.length - 1
      ui.floatingPanel.xpath[lastIdx].value = xpath
      ui.floatingPanel.xpath[lastIdx].text = `Custom: ${xpath}`
      ui.floatingPanel.xpath[lastIdx].disabled = false
    }
    // update counter with index and size
    xmlEditor.whenReady().then(() => updateCounter(pathBeforePredicates, index))
  }

  // configure node status buttons
  ui.floatingPanel.markNodeButtons.querySelector("button").forEach(btn => btn.disabled = !Boolean(state.xpath))

  // configure diff navigation buttons
  ui.floatingPanel.diffNavigation.querySelectorAll("button").forEach(node => node.disabled = !(value && value !== state.xmlPath))
}

/**
 * Given an xpath and an index, displays the index and the number of occurrences of the 
 * xpath in the xml document. If none can be found, the index is displayed as 0.
 * @param {string} xpath The xpath that will be counted
 * @param {Number} index The index 
 */
function updateCounter(xpath, index) {
  let size;
  try {
    size = xmlEditor.countDomNodesByXpath(xpath)
  } catch (e) {
    console.error(e)
    size = 0
  }
  index = index || 1
  ui.floatingPanel.selectionIndex.textContent = `(${size > 0 ? index : 0}/${size})`
  ui.floatingPanel.nextNode.disabled = ui.floatingPanel.previousNode.disabled = size < 2;
}


//
// Event handlers
//

/**
 * Called when the switch for auto-search is toggled
 * @param {Event} evt 
 */
async function onAutoSearchSwitchChange(evt) {
  const checked = evt.detail.checked
  logger.info(`Auto search is: ${checked}`)
  if (checked && xmlEditor.selectedNode) {
    await services.searchNodeContentsInPdf(xmlEditor.selectedNode)
  }
}

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

  // document.addEventListener('mouseleave', () => {
  //   if (isDragging) {
  //     isDragging = false;
  //     element.style.cursor = 'grab'; // Restore cursor after dragging
  //     element.style.userSelect = 'auto'; // Restore text selection
  //   }
  // });
}

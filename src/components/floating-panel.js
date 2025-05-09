import { app, PdfTeiEditor } from '../app.js'
import { selectByValue, $$ } from '../modules/browser-utils.js'
import { xpathInfo, parseXPath } from '../modules/utils.js'

import '../modules/switch.js'

// name of the component
const componentId = "floating-panel"

// component htmnl
const html = `
  <style>
    #${componentId} {
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

    #${componentId}  * {
      font-size: small;
    }

    #${componentId} > div {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #${componentId} > div > * {
      display: inline;
    }      
  </style>
  <div id="${componentId}">
    <div>
      <span class="navigation-text">Navigate by</span>
      <select name="xpath"></select>
      <button name="edit-xpath">Custom XPath</button>
      <button name="prev-node" disabled>&lt;&lt;</button>
      <span name="selection-index" class="navigation-text"></span>
      <button name="next-node" disabled>&gt;&gt;</button>
    </div>
    <div>
      <span class="navigation-text">Mark node as</span>
      <button class="node-status" data-status="verified" disabled>Verified</button>
      <button class="node-status" data-status="unresolved" disabled>Unresolved</button>
      <button class="node-status" data-status="" disabled>Clear node</button>
      <!-- button class="node-status" data-status="comment" disabled>Add comment</button-->
    </div>
    <div>
      <custom-switch name="switch-auto-search" label="Find node" label-on="On" label-off="off"></custom-switch>
      <span name="nav-diff">
        <button name="prev-diff" disabled>Prev. Diff</button>
        <button name="next-diff" disabled>Next Diff</button>
        <button name="diff-keep-all" disabled>Keep all</button>
        <button name="diff-change-all" disabled>Change all</button>
      </span>
    </div>
  </div>
`
const div = document.createElement("div")
div.innerHTML = html.trim()
document.body.appendChild(div)

/**
 * @type {Element}
 */
const componentNode = document.getElementById(componentId)

/**
 * component API
 */
const api = {

  show: () => componentNode.classList.remove("hidden"),
  hide: () => componentNode.classList.add("hidden"),

  /**
   * Add an element to the given row
   * @param {Element} element 
   * @param {Number} row 
   * @param {string} name
   */
  add: (element, row, name) => {
    if (name) {
      element.name = name
    }
    getOrCreateRow(row).appendChild(element)
  },

  /**
   * Add an element at the specific index in the given row
   * @param {Element} element 
   * @param {Number} row 
   * @param {Number} index 
   * @param {string} name
   */
  addAt: (element, row, index, name) => {
    if (name) {
      element.name = name
    }
    const parent = getOrCreateRow(row)
    parent.insertBefore(element, parent.childNodes[index])
  },

  /**
   * Returns the child element of that name
   * @param {string} name The name of the child element
   * @returns {Element}
   */
  getByName: name => {
    const namedElems = componentNode.querySelectorAll(`[name="${name}"]:not(sl-icon)`) // we need to exclude sl-icon elements
    if (namedElems.length === 1) {
      return namedElems[0]
    }
    throw new Error(`No or more than one child element with the name "${name}"`)
  },

  /**
   * Attaches a click event handler to a named subelement of the component
   * @param {string} name The name of the element
   * @param {Function} handler The function to call when the element is clicked
   */
  onClick: (name, handler) => {
    api.getByName(name).addEventListener('click', handler)
  },

  /**
   * Updates data such as select box options
   */
  update: () => {
    populateXpathSelectbox()
  }
}

/**
 * component plugin
 */
const plugin = {
  name: componentId,
  install
}

export { api, plugin }
export default plugin

//
// implementations
//

// UI elements
const xpathSelectbox = api.getByName("xpath")

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent(componentId, api, "floatingPanel")

  // populate the xpath selectbox

  // Clear existing options
  xpathSelectbox.innerHTML = '';

  // Populate select box with options
  const selectBoxData = await app.client.getConfigValue("navigation.xpath.list")
  selectBoxData.forEach(item => {
    const option = document.createElement('option');
    option.value = item.value || ''
    option.text = item.label
    option.disabled = item.xpath === null
    xpathSelectbox.appendChild(option);
  });

  // listen for changes in the selectbox
  xpathSelectbox.addEventListener('change', () => {
    app.xpath = xpathSelectbox.value
  });

  // button to edit the xpath manually
  api.onClick('edit-xpath', () => {
    const custom = xpathSelectbox[xpathSelectbox.length - 1]
    const xpath = prompt("Enter custom xpath", custom.value)
    if (xpath && xpath.trim()) {
      custom.value = xpath
      custom.text = `Custom: ${xpath}`
      xpathSelectbox.selectedIndex = xpathSelectbox.length - 1
    }
  })

  // setup click handlers
  api.onClick('prev-node', () => app.xmleditor.previousNode());
  api.onClick('next-node', () => app.xmleditor.nextNode());
  api.onClick('prev-diff', () => app.xmleditor.goToPreviousDiff())
  api.onClick('next-diff', () => app.xmleditor.goToNextDiff())

  api.onClick('diff-keep-all', () => {
    app.xmleditor.rejectAllDiffs()
    app.services.removeMergeView()
  })
  api.onClick('diff-change-all', () => {
    app.xmleditor.acceptAllDiffs()
    app.services.removeMergeView()
  })

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener([`#${componentId}`, '.cm-panels']);

  // make navigation draggable
  makeDraggable(componentNode)

  // auto-search switch
  api.getByName('switch-auto-search').addEventListener('change', onAutoSearchSwitchChange)

  // configure "status" buttons
  $$('.node-status').forEach(btn => btn.addEventListener('click', evt => {
    api.setNodeStatus(api.selectedNode, evt.target.dataset.status)
  }))

  // allow to input node index
  api.onClick('selection-index', onClickSelectionIndex)

  // update selectbox when corresponding app state changes
  app.on("change:xpath", onAppChangeXpath)

  app.on("change:diffXmlPath", onAppChangeDiffXmlPath)

  app.logger.info("Floating panel component installed.")
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
    size = app.xmleditor.countDomNodesByXpath(xpath)
  } catch (e) {
    console.error(e)
    size = 0
  }
  index = index || 1
  api.getByName('selection-index').textContent = `(${size > 0 ? index : 0}/${size})`
  api.getByName('next-node').disabled = api.getByName('prev-node').disabled = size < 2;
}



//
// Event handlers
//

/**
 * Called when the xpath app state changes
 * @param {string} xpath 
 * @param {string|null} old 
 * @returns 
 */
function onAppChangeXpath(xpath, old) {

  // enable the buttons if we have an selected xpath
  $$('.node-status').forEach(btn => btn.disabled = !Boolean(xpath))

  if (!xpath) {
    return
  }

  let { index,  } = parseXPath(xpath)

  try {
    // this sets the xpath selectbox to one of the existing values
    selectByValue(xpathSelectbox, indexParent)
  } catch (error) {
    // the value does not exist, save it to the last option
    let lastIdx = xpathSelectbox.length - 1
    xpathSelectbox[lastIdx].value = xpath
    xpathSelectbox[lastIdx].text = `Custom: ${xpath}`
    xpathSelectbox[lastIdx].disabled = false
  }

  // update counter with index and size
  app.xmleditor.whenReady().then(() => updateCounter(indexParent, index))
}



/**
 * Called when the switch for auto-search is toggled
 * @param {Event} evt 
 */
async function onAutoSearchSwitchChange(evt) {
  const checked = evt.detail.checked
  app.logger.info(`Auto search is: ${checked}`)
  if (checked && app.xmleditor.selectedNode) {
    await app.services.searchNodeContentsInPdf(app.xmleditor.selectedNode)
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
    app.xmleditor.selectByIndex(parseInt(index))
  } catch (error) {
    app.dialog.error(error.message)
  }
}


/**
 * Called when the diffXmlPath state changes. Enables or disables the div navigation buttons
 * based on whether 
 * @param {string} value The new value of the diffXmlPath state
 * @param {string} old 
 */
function onAppChangeDiffXmlPath(value, old) {
  api.getByName("nav-diff")
    .querySelectorAll("button")
    .forEach(node => node.disabled = !(value && value !== app.xmlPath))
}

//
// helper functions
//

/**
 * Returns a div for the row with the given number. If the number is higher than the existing number of 
 * rows, a new one is created and returned.
 * @param {Number} row The number of the row to get or to create if it does not yet exist
 * @returns {Element}
 */
function getOrCreateRow(row) {
  if (componentNode.childElementCount <= row) {
    const div = document.createElement('DIV')
    api.appendChild(div)
    return div
  }
  return api.childNodes[row]
}


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

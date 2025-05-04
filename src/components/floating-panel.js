import { app, PdfTeiEditor } from '../app.js'
import { setSelectboxIndex, makeDraggable, addBringToForegroundListener, UrlHash, $, $$ } from '../modules/browser-utils.js'
import { $, $$ } from '../modules/browser-utils.js'

// name of the component
const name = "floating-panel"

const html = `
  <style>
    #navigation {
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
  </style>
  <div id="navigation">
    <div class="doc-navigation-row">
      <span class="navigation-text">Navigate by</span>
      <select id="select-xpath" name="xpath"></select>
      <button id="btn-edit-xpath">Custom XPath</button>
      <button id="btn-prev-node" disabled>&lt;&lt;</button>
      <span id="selection-index" class="navigation-text"></span>
      <button id="btn-next-node" disabled>&gt;&gt;</button>
    </div>
    <div class="doc-navigation-row">
      <span class="navigation-text">Mark node as</span>
      <button class="btn-node-status" data-status="verified" disabled>Verified</button>
      <button class="btn-node-status" data-status="unresolved" disabled>Unresolved</button>
      <button class="btn-node-status" data-status="" disabled>Clear node</button>
      <!-- button class="btn-node-status" data-status="comment" disabled>Add comment</button-->
    </div>
    <div class="doc-navigation-row">
      <custom-switch id="switch-auto-search" label="Find node" label-on="On" label-off="off"></custom-switch>
      <span id="nav-diff">
        <button id="btn-prev-diff" disabled>Prev. Diff</button>
        <button id="btn-next-diff" disabled>Next Diff</button>
        <button id="btn-diff-keep-all" disabled>Keep all</button>
        <button id="btn-diff-change-all" disabled>Change all</button>
      </span>
    </div>
  </div>
`

/**
 * @type {Element}
 */
const floatingPanelDiv = document.createElement("div")
floatingPanelDiv.outerHTML = html.trim()
document.body.appendChild(floatingPanelDiv)

/**
 * component API
 */
export const floatingPaneComponent = {

  show: () => floatingPanelDiv.classList.remove("hidden"),
  hide: () => floatingPanelDiv.classList.add("hidden"),

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
    const namedElems = floatingPanelDiv.querySelectorAll(`[name="${name}"]`)
    if (namedElems.length === 1) {
      return namedElems[0]
    }
    throw new Error(`No or more than one child element with the name "${name}"`)
  },

  /**
   * Updates data such as select box options
   */
  update: () => {
    
  }
}

// UI elements
const xpathSelectbox = floatingPaneComponent.getByName("xpath")

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent(name, floatingPaneComponent, "floatingPanel")
  app.registerState("xpath", null, "xpath", "xpath")

  populateXpathSelectbox() 
  setupEventHandlers()

  // update selectbox when corresponding app state changes
  app.on("change:xpath", onXpathChange)

  // set the corresponding app state from the hash or from the first selectbox entry
  app.xpath = UrlHash.get('xpath') || xpathSelectbox.value

  console.log("Floating panel plugin installed.")
}

/**
 * component plugin
 */
const floatingPanelPlugin = {
  name,
  app: { start }
}

export { floatingPaneComponent, floatingPanelPlugin }
export default floatingPanelPlugin

//
// helper methods
//


/**
 * Returns a div for the row with the given number. If the number is higher than the existing number of 
 * rows, a new one is created and returned.
 * @param {Number} row The number of the row to get or to create if it does not yet exist
 * @returns {Element}
 */
function getOrCreateRow(row) {
  if (floatingPanelDiv.childElementCount <= row) {
    const div = document.createElement('DIV')
    div.classList.add("doc-navigation-row")
    floatingPaneComponent.appendChild(div)
    return div
  }
  return floatingPaneComponent.childNodes[row]
}

/**
 * Populates the selectbox for the xpath expressions that  control the navigation within the xml document
 */
function populateXpathSelectbox() {
  try {
    const data = [
      {
        "xpath": "//tei:biblStruct",
        "label": "<biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[@status='verified']",
        "label": "Verified <biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[not(@status='verified')]",
        "label": "Unverified <biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[@status='unresolved']",
        "label": "Unresolved <biblStruct>"
      },
      {
        "xpath": null,
        "label": "Custom XPath"
      }
    ];

    // Clear existing options
    xpathSelectbox.innerHTML = '';

    // Populate select box with options
    data.forEach(item => {
      const option = document.createElement('option');
      option.value = item.xpath || ''
      option.text = item.label
      option.disabled = item.xpath === null
      xpathSelectbox.appendChild(option);
    });

  } catch (error) {
    console.error('Error populating xpath selectbox:', error);
  }
}


/**
 * configures the event handlers for this component
 */
function setupEventHandlers() {

  // listen for changes in the selectbox
  xpathSelectbox.addEventListener('change', () => {
    app.xpath = xpathSelectbox.value
  });

  // button to edit the xpath manually
  $('#btn-edit-xpath').click(() => {
    const custom = xpathSelectbox[xpathSelectbox.length - 1]
    const xpath = prompt("Enter custom xpath", custom.value)
    if (xpath && xpath.trim()) {
      custom.value = xpath
      custom.text = `Custom: ${xpath}`
      xpathSelectbox.selectedIndex = xpathSelectbox.length - 1
    }
  })

  // setup click handlers
  $('#btn-prev-node').click(() => app.xmleditor.previousNode());
  $('#btn-next-node').click(() => app.xmleditor.nextNode());
  $('#btn-prev-diff').click(() => app.xmleditor.goToPreviousDiff())
  $('#btn-next-diff').click(() => app.xmleditor.goToNextDiff())

  $('#btn-diff-keep-all').click(() => {
    app.xmleditor.rejectAllDiffs()
    app.services.removeMergeView()
  })
  $('#btn-diff-change-all').click(() => {
    app.xmleditor.acceptAllDiffs()
    app.services.removeMergeView()
  })

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

  // auto-search switch
  $('#switch-auto-search').addEventListener('change', onAutoSearchSwitchChange)

  // configure "status" buttons
  $$('.btn-node-status').forEach(btn => btn.addEventListener('click', evt => setNodeStatus(evt.target.dataset.status)))

  // allow to input node index
  $('#selection-index').click(onClickSelectionIndex)
}

function onXpathChange(xpath, old){
  if (!xpath) {
    return
  }
  let {index, beforeIndex } = app.services.xpathInfo(xpath)
  try {
    // this sets the xpath selectbox to one of the existing values
    setSelectboxIndex(xpathSelectbox, beforeIndex)
  } catch(error) {
    // the value does not exist, save it to the last option
    let lastIdx = xpathSelectbox.length - 1
    xpathSelectbox[lastIdx].value = xpath
    xpathSelectbox[lastIdx].text = `Custom: ${xpath}`
    xpathSelectbox[lastIdx].disabled = false
  }

  // update counter
  let size = app.services.getXpathResultSize(xpath)
  $('#selection-index').textContent = `(${size > 0 ? index : 0}/${size})`
  $('#btn-next-node').disabled = $('#btn-prev-node').disabled = size < 2;
}

/**
 * Called when the switch for auto-search is toggled
 * @param {Event} evt 
 */
async function onAutoSearchSwitchChange(evt) {
  const checked = evt.detail.checked
  console.log(`Auto search is: ${checked}`)
  if (checked) {
    await app.services.searchNodeContentsInPdf(lastSelectedXpathlNode)
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
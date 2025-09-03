/** 
 * @import { ApplicationState } from '../app.js'
 * @import { UIPart } from '../ui.js'
 */
import { updateState, client, logger, services, dialog, xmlEditor } from '../app.js'
import { $$ } from '../modules/browser-utils.js'
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

let currentVariant = null
let currentUser = null
let cachedExtractors = null

/** @type {ApplicationState} */
let currentState;


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

  // populate the xpath selectbox (will be empty until user logs in)
  await populateXpathSelectbox(state);

  // define shorthand for xpath selectbox
  const xp = ui.floatingPanel.xpath;

  // listen for changes in the selectbox
  xp.addEventListener('change', async () => {
    await updateState(currentState, { xpath: xp.value })
  });

  // Edit XPath button functionality removed for now

  // setup event handlers
  const fp = ui.floatingPanel

  // node navigation
  fp.previousNode.addEventListener('click', () => changeNodeIndex(currentState, -1));
  fp.nextNode.addEventListener('click', () => changeNodeIndex(currentState, +1));

  // diff navigation
  fp.diffNavigation.prevDiff.addEventListener('click', () => xmlEditor.goToPreviousDiff())
  fp.diffNavigation.nextDiff.addEventListener('click', () => xmlEditor.goToNextDiff())
  fp.diffNavigation.diffKeepAll.addEventListener('click', () => {
    xmlEditor.rejectAllDiffs()
    services.removeMergeView(currentState)
  })
  fp.diffNavigation.diffChangeAll.addEventListener('click', () => {
    xmlEditor.acceptAllDiffs()
    services.removeMergeView(currentState)
  })

  fp.selectionIndex.addEventListener('click', onClickSelectionIndex) // allow to input node index

  // configure "status" buttons
  $$('.node-status').forEach(btn => btn.addEventListener('click', async evt => {
    if (!currentState.xpath) {
      return
    }
    xmlEditor.selectByXpath(currentState.xpath)
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
  currentState = state
  
  // Cache extractor list when user actually changes (not just stale initialization)
  let extractorsJustCached = false
  if (currentUser !== state.user && state.user !== null) {
    const previousUser = currentUser
    currentUser = state.user
    
    // Only fetch extractors if we don't have them cached or this is a real user change
    if (!cachedExtractors || (previousUser !== null && previousUser !== state.user)) {
      try {
        cachedExtractors = await client.getExtractorList()
        extractorsJustCached = true
        logger.debug('Cached extractor list for floating panel:'+ cachedExtractors)
      } catch (error) {
        logger.warn('Failed to load extractor list:' +  error.message || error)
        cachedExtractors = []
      }
    }
  }
  
  // Check if variant has changed or extractors were just cached, repopulate xpath selectbox
  if (currentVariant !== state.variant || extractorsJustCached) {
    currentVariant = state.variant
    await populateXpathSelectbox(state)
  }
  
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
      // the value does not exist in predefined options, select none
      ui.floatingPanel.xpath.selectedIndex = -1
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
  // Use the actual xpath from state, parse out the base path
  let { pathBeforePredicates, nonIndexPredicates, index } = parseXPath(state.xpath)
  const normativeXpath = pathBeforePredicates + nonIndexPredicates
  const size = xmlEditor.countDomNodesByXpath(normativeXpath)
  if (size < 2) return
  if (index === null) index = 1
  index += delta
  if (index < 0) index = size 
  if (index >= size) index = 1
  const xpath = normativeXpath + `[${index}]`
  await updateState(currentState, { xpath })
}


/**
 * Populates the xpath selectbox based on the current variant
 * @param {ApplicationState} state
 */
async function populateXpathSelectbox(state) {
  const xp = ui.floatingPanel.xpath

  // Clear existing options
  xp.innerHTML = '';

  const variantId = state.variant
  //console.log('populateXpathSelectbox called with variant:', variantId, 'cachedExtractors:', cachedExtractors)

  if (!variantId) {
    // No variant selected, show empty selectbox
    const option = document.createElement('option');
    option.value = ''
    option.text = 'No variant selected'
    option.disabled = true
    xp.appendChild(option);
    return
  }

  // Use cached extractor list to find navigation xpath data
  if (!cachedExtractors) {
    // Show error fallback
    const option = document.createElement('option');
    option.value = ''
    option.text = 'Error loading navigation paths'
    option.disabled = true
    xp.appendChild(option);
    return
  }
  
  // Find the extractor that contains this variant
  let navigationXpathList = null
  for (const extractor of cachedExtractors) {
    //console.log('Checking extractor:', extractor.id, 'for variant:', variantId, 'navigation_xpath:', extractor.navigation_xpath)
    const navigationXpath = extractor.navigation_xpath?.[variantId]
    if (navigationXpath) {
      navigationXpathList = navigationXpath
      logger.debug('Found navigation xpath list:', navigationXpathList)
      break
    }
  }

  if (!navigationXpathList) {
    // Variant not found in any extractor, show fallback
    const option = document.createElement('option');
    option.value = ''
    option.text = `No navigation paths for variant: ${variantId}`
    option.disabled = true
    xp.appendChild(option);
    return
  }

  // Populate select box with options from extractor (skip null values)
  navigationXpathList.forEach(item => {
    if (item.value !== null) {
      const option = document.createElement('option');
      option.value = item.value
      option.text = item.label
      xp.appendChild(option);
    }
  });
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

// Custom XPath editing functionality removed for now

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

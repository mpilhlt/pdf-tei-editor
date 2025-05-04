import { app, PdfTeiEditor } from '../app.js'

// name of the component
const name = "floating-panel"

/**
 * @type {Element}
 */
const floatingPanelDiv = $('#navigation')

/**
 * component API
 */
export const floatingPaneComponent = {
  /**
   * Add an element to the given row
   * @param {Element} element 
   * @param {Number} row 
   */
  add: (element, row) => {
    getOrCreateRow(row).appendChild(element)
  },
  /**
   * Add an element at the specific index in the given row
   * @param {Element} element 
   * @param {Number} row 
   * @param {Number} index 
   */
  addAt: (element, row, index) => {
    const parent = getOrCreateRow(row)
    parent.insertBefore(element, parent.childNodes[index])
  }
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent(name, floatingPaneComponent, "floatingPanel")
  setupEventHandlers()
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

// helper method
function getOrCreateRow(row) {
  if (floatingPanelDiv.childElementCount <= row) {
    const div = document.createElement('DIV')
    div.classList.add("doc-navigation-row")
    floatingPaneComponent.appendChild(div)
    return div
  }
  return floatingPaneComponent.childNodes[row]
}




function setupEventHandlers() {
  // setup click handlers
  $('#btn-prev-node').click(() => app.xmleditor.previousNode());
  $('#btn-next-node').click(() => nextNode());
  $('#btn-prev-diff').click(() => app.xmleditor.goToPreviousDiff())
  $('#btn-next-diff').click(() => app.xmleditor.goToNextDiff())
  $('#btn-diff-keep-all').click(() => {
    app.xmleditor.rejectAllDiffs()
    removeMergeView()
  })
  $('#btn-diff-change-all').click(() => {
    app.xmleditor.acceptAllDiffs()
    removeMergeView()
  })

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

  // configure "status" buttons
  $$('.btn-node-status').forEach(btn => btn.addEventListener('click', evt => setNodeStatus(evt.target.dataset.status)))

  // allow to input node index
  $('#selection-index').addEventListener('click', onClickSelectionIndex)

  // when everything is configured, we can show the navigation
  $('#navigation').show()
}

async function onAutoSearchSwitchChange(evt) {
  const checked = evt.detail.checked
  console.log(`Auto search is: ${checked}`)
  if (checked) {
    await searchNodeContentsInPdf(lastSelectedXpathlNode)
  }
}

function onClickSelectionIndex() {
  let index = prompt('Enter node index')
  if (!index) return;
  try {
    selectByIndex(parseInt(index))
  } catch (error) {
    window.app.dialog.error(error.message)
  }
}


/**
 * Sets the status attribute of the last selected node, or removes it if the status is empty
 * @param {string} status The new status, can be "verified", "unresolved", "comment" or ""
 * @returns {Promise<void>}
 * @throws {Error} If the status is not one of the allowed values
 */
async function setNodeStatus(status) {
  if (!lastSelectedXpathlNode) {
    return
  }
  // update XML document from editor content
  app.xmleditor.updateNodeFromEditor(lastSelectedXpathlNode)

  // set/remove the status attribute
  switch (status) {
    case "":
      lastSelectedXpathlNode.removeAttribute("status")
      break;
    case "comment":
      throw new Error("Commenting not implemented yet")
      // const comment = prompt(`Please enter the comment to store in the ${lastSelectedXpathlNode.tagName} node`)
      // if (!comment) {
      //   return
      // }
      // const commentNode = xmlEditor.getXmlTree().createComment(comment)
      // const firstElementNode = Array.from(lastSelectedXpathlNode.childNodes).find(node => node.nodeType === Node.ELEMENT_NODE)
      // const insertBeforeNode = firstElementNode || lastSelectedXpathlNode.firstChild || lastSelectedXpathlNode
      // if (insertBeforeNode.previousSibling && insertBeforeNode.previousSibling.nodeType === Node.TEXT_NODE) {
      //   // indentation text
      //   lastSelectedXpathlNode.insertBefore(insertBeforeNode.previousSibling.cloneNode(), insertBeforeNode)
      // } 
      // lastSelectedXpathlNode.insertBefore(commentNode, insertBeforeNode.previousSibling)
      break;
    default:
      lastSelectedXpathlNode.setAttribute("status", status)
  }
  // update the editor content
  await app.xmleditor.updateEditorFromNode(lastSelectedXpathlNode)

  // reselect the current node when done
  selectByIndex(currentIndex)
}

function updateIndexUI(index, size) {
  $('#selection-index').textContent = `(${size > 0 ? index : 0}/${size})`
  $('#btn-next-node').disabled = $('#btn-prev-node').disabled = size < 2;
}
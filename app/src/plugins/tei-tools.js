/**
 * TEI Tools plugin - provides utilities for working with TEI documents
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import SlDrawer from '@shoelace-style/shoelace/dist/components/drawer/drawer.js'
 * @import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js'
 */

/**
 * TEI revision history drawer navigation properties
 * @typedef {object} teiRevisionHistoryDrawerPart
 * @property {HTMLDivElement} content - The drawer content container
 * @property {HTMLTableElement} revisionTable - The revision history table
 * @property {HTMLTableSectionElement} revisionTableBody - The table body element
 * @property {SlButton} closeBtn - The close button
 */

import ui, { updateUi } from '../ui.js'
import { logger } from '../app.js'
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js'
import { api as xmlEditor } from './xmleditor.js'

// Register templates
await registerTemplate('tei-tools-statusbar', 'tei-tools-statusbar.html')
await registerTemplate('tei-revision-history-drawer', 'tei-revision-history-drawer.html')

/**
 * Current state for use in event handlers
 * @type {ApplicationState}
 */
let currentState

/**
 * Get teiHeader visibility preference from localStorage
 * @returns {boolean} Header visibility enabled state (defaults to false - folded)
 */
function getTeiHeaderVisibilityPreference() {
  const stored = localStorage.getItem('tei-tools.teiHeaderVisible')
  return stored === 'true'
}

/**
 * Set teiHeader visibility preference in localStorage
 * @param {boolean} visible - Whether the header should be visible
 */
function setTeiHeaderVisibilityPreference(visible) {
  localStorage.setItem('tei-tools.teiHeaderVisible', String(visible))
}

/**
 * teiHeader visibility state (initialized from localStorage)
 * @type {boolean}
 */
let teiHeaderVisible = getTeiHeaderVisibilityPreference()

/**
 * Plugin object
 */
const plugin = {
  name: "tei-tools",
  deps: ['xmleditor'],
  install,
  start,
  onStateUpdate
}

export { plugin }
export default plugin

/**
 * Runs when the main app starts
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create statusbar widgets and add to XML editor statusbar
  const statusbarWidgets = createFromTemplate('tei-tools-statusbar')
  statusbarWidgets.forEach(widget => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.statusbar.add(widget, 'left', 2)
    }
  })

  // Create revision history drawer
  createFromTemplate('tei-revision-history-drawer', document.body)

  // Update UI to register the drawer in the ui object
  updateUi()

  // Listen to xmlEditor events
  xmlEditor.on("editorAfterLoad", () => {
    xmlEditor.whenReady().then(() => {
      updateTeiHeaderToggle()
      updateRevisionHistoryButton()
    })
  })
}

/**
 * Runs after all plugins are installed to set up event handlers
 * @param {ApplicationState} state
 */
async function start(state) {
  logger.debug(`Starting plugin "${plugin.name}"`)

  // Set up event listeners (after updateUi() has been called)

  // teiHeader toggle switch
  ui.xmlEditor.statusbar.teiHeaderToggleWidget.addEventListener('sl-change', (event) => {
    const isChecked = event.target.checked
    toggleTeiHeaderVisibility(isChecked)
  })

  // Revision history button
  ui.xmlEditor.statusbar.revisionHistoryBtn.addEventListener('widget-click', () => {
    showRevisionHistory()
  })

  // Revision history drawer close button
  ui.teiRevisionHistoryDrawer.closeBtn.addEventListener('click', () => {
    ui.teiRevisionHistoryDrawer.hide()
  })
}

/**
 * Called when state updates
 * @param {string[]} changedKeys
 * @param {ApplicationState} state
 */
async function onStateUpdate(changedKeys, state) {
  currentState = state

  // Keep Header switch visible but disable when no document is loaded
  const hasDocument = !!state.xml
  ui.xmlEditor.statusbar.teiHeaderToggleWidget.disabled = !hasDocument
  ui.xmlEditor.statusbar.teiHeaderLabel.style.opacity = hasDocument ? '1' : '0.5'

  // Hide revision history button when no document
  if (!hasDocument) {
    ui.xmlEditor.statusbar.revisionHistoryBtn.style.display = 'none'
  }
}

/**
 * Updates the teiHeader toggle widget visibility and state
 */
function updateTeiHeaderToggle() {
  const teiHeaderToggleWidget = ui.xmlEditor.statusbar.teiHeaderToggleWidget
  const teiHeaderLabel = ui.xmlEditor.statusbar.teiHeaderLabel

  // Check if document has a teiHeader
  const hasTeiHeader = !!xmlEditor.getDomNodeByXpath("//tei:teiHeader")

  // Enable/disable based on whether document has teiHeader
  teiHeaderToggleWidget.disabled = !hasTeiHeader
  teiHeaderLabel.style.opacity = hasTeiHeader ? '1' : '0.5'

  if (hasTeiHeader) {
    // Apply user's preference for teiHeader visibility
    const preferredVisible = getTeiHeaderVisibilityPreference()
    try {
      if (preferredVisible) {
        xmlEditor.unfoldByXpath('//tei:teiHeader')
        teiHeaderVisible = true
      } else {
        xmlEditor.foldByXpath('//tei:teiHeader')
        teiHeaderVisible = false
      }
      teiHeaderToggleWidget.checked = preferredVisible
    } catch (error) {
      logger.debug(`Error setting teiHeader visibility: ${String(error)}`)
    }
  }
}

/**
 * Updates the revision history button visibility
 */
function updateRevisionHistoryButton() {
  const revisionHistoryBtn = ui.xmlEditor.statusbar.revisionHistoryBtn

  // Check if document has a revisionDesc
  const hasRevisionDesc = !!xmlEditor.getDomNodeByXpath("//tei:revisionDesc")

  if (hasRevisionDesc) {
    revisionHistoryBtn.style.display = 'inline-flex'
  } else {
    revisionHistoryBtn.style.display = 'none'
  }
}

/**
 * Toggles the visibility of the teiHeader node
 * @param {boolean} show - Whether to show or hide the teiHeader
 */
function toggleTeiHeaderVisibility(show) {
  if (!xmlEditor.isReady()) return

  try {
    if (show) {
      // Unfold the teiHeader
      xmlEditor.unfoldByXpath('//tei:teiHeader')
      teiHeaderVisible = true
      logger.debug('Unfolded teiHeader')
    } else {
      // Fold the teiHeader
      xmlEditor.foldByXpath('//tei:teiHeader')
      teiHeaderVisible = false
      logger.debug('Folded teiHeader')
    }
    // Persist the preference
    setTeiHeaderVisibilityPreference(show)
  } catch (error) {
    logger.warn(`Error toggling teiHeader visibility: ${String(error)}`)
  }
}

/**
 * Shows the revision history drawer with data from revisionDesc
 */
function showRevisionHistory() {
  if (!xmlEditor.isReady()) return

  const xmlTree = xmlEditor.getXmlTree()
  if (!xmlTree) {
    logger.warn('No XML tree available')
    return
  }

  // Get all change elements from revisionDesc
  const changeNodes = Array.from(xmlTree.querySelectorAll('revisionDesc change'))

  if (changeNodes.length === 0) {
    logger.debug('No revision history found')
    return
  }

  // Sort by date descending (newest first)
  changeNodes.sort((a, b) => {
    const dateA = a.getAttribute('when') || ''
    const dateB = b.getAttribute('when') || ''
    return dateB.localeCompare(dateA) // Descending order
  })

  // Get respStmt entries for looking up full names
  const respStmtMap = buildRespStmtMap(xmlTree)

  // Clear existing table rows
  const tbody = ui.teiRevisionHistoryDrawer.revisionTable.revisionTableBody
  tbody.innerHTML = ''

  // Build table rows from change elements
  changeNodes.forEach((changeNode, index) => {
    const row = document.createElement('tr')
    row.style.borderBottom = '1px solid var(--sl-color-neutral-100)'

    // Alternate row background
    if (index % 2 === 1) {
      row.style.backgroundColor = 'var(--sl-color-neutral-50)'
    }

    // Hover effect
    row.addEventListener('mouseenter', () => {
      row.style.backgroundColor = 'var(--sl-color-neutral-100)'
    })
    row.addEventListener('mouseleave', () => {
      if (index % 2 === 1) {
        row.style.backgroundColor = 'var(--sl-color-neutral-50)'
      } else {
        row.style.backgroundColor = ''
      }
    })

    const cellStyle = 'padding: 0.75rem 1rem; color: var(--sl-color-neutral-700);'

    // Date column
    const dateCell = document.createElement('td')
    dateCell.style.cssText = cellStyle + ' font-family: var(--sl-font-mono); font-size: 0.8125rem; white-space: nowrap;'
    const whenAttr = changeNode.getAttribute('when')
    dateCell.textContent = formatDate(whenAttr)
    row.appendChild(dateCell)

    // Description column
    const descCell = document.createElement('td')
    descCell.style.cssText = cellStyle
    const descNode = changeNode.querySelector('desc')
    descCell.textContent = descNode ? descNode.textContent.trim() : ''
    row.appendChild(descCell)

    // Status column
    const statusCell = document.createElement('td')
    statusCell.style.cssText = cellStyle + ' text-transform: capitalize;'
    const statusAttr = changeNode.getAttribute('status')
    if (statusAttr) {
      statusCell.textContent = statusAttr
      // Add a subtle badge-like background for status
      statusCell.style.fontWeight = '500'
      statusCell.style.color = 'var(--sl-color-primary-600)'
    }
    row.appendChild(statusCell)

    // Who column
    const whoCell = document.createElement('td')
    whoCell.style.cssText = cellStyle
    const whoAttr = changeNode.getAttribute('who')
    if (whoAttr) {
      const whoId = whoAttr.replace('#', '')
      whoCell.textContent = respStmtMap[whoId] || whoAttr
    }
    row.appendChild(whoCell)

    tbody.appendChild(row)
  })

  // Show the drawer
  ui.teiRevisionHistoryDrawer.show()
}

/**
 * Builds a map of xml:id to full name from respStmt elements
 * @param {Document} xmlTree
 * @returns {Object.<string, string>}
 */
function buildRespStmtMap(xmlTree) {
  const map = {}
  const persNameNodes = xmlTree.querySelectorAll('respStmt persName[xml\\:id]')

  persNameNodes.forEach(node => {
    const xmlId = node.getAttribute('xml:id')
    const fullName = node.textContent.trim()
    if (xmlId && fullName) {
      map[xmlId] = fullName
    }
  })

  return map
}

/**
 * Formats a date string to YYYY-MM-DD HH:mm:SS format
 * @param {string|null} dateStr
 * @returns {string}
 */
function formatDate(dateStr) {
  if (!dateStr) return ''

  try {
    const date = new Date(dateStr)

    // Check if date is valid
    if (isNaN(date.getTime())) {
      // Return as-is if it's just a date without time
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return `${dateStr} 00:00:00`
      }
      return dateStr
    }

    // Format as YYYY-MM-DD HH:mm:SS
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  } catch (error) {
    logger.debug(`Error formatting date: ${String(error)}`)
    return dateStr
  }
}

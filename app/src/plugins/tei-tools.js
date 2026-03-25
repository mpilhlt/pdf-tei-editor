/**
 * TEI Tools plugin - provides utilities for working with TEI documents
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlDrawer } from '../ui.js'
 * @import { teiRevisionHistoryDrawerPart } from '../templates/tei-revision-history-drawer.types.js'
 * @import { teiToolsStatusbarPart } from '../templates/tei-tools-statusbar.types.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'

// Register templates
await registerTemplate('tei-tools-statusbar', 'tei-tools-statusbar.html')
await registerTemplate('tei-revision-history-drawer', 'tei-revision-history-drawer.html')

/**
 * Get teiHeader visibility preference from localStorage
 * @returns {boolean}
 */
function getTeiHeaderVisibilityPreference() {
  const stored = localStorage.getItem('tei-tools.teiHeaderVisible')
  return stored === 'true'
}

/**
 * Set teiHeader visibility preference in localStorage
 * @param {boolean} visible
 */
function setTeiHeaderVisibilityPreference(visible) {
  localStorage.setItem('tei-tools.teiHeaderVisible', String(visible))
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

class TeiToolsPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tei-tools', deps: ['xmleditor', 'logger'] })
  }

  get #xmlEditorApi() { return this.getDependency('xmleditor') }

  /** @type {SlDrawer & teiRevisionHistoryDrawerPart} */
  #ui = null

  /** @type {StatusButton} */
  #revisionHistoryBtn;
  #teiHeaderToggleWidget;
  #teiHeaderLabel;

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "tei-tools"`)

    const xmlEditorApi = this.getDependency('xmleditor')

    const statusbarWidgets = createFromTemplate('tei-tools-statusbar')
    const tooltipEl = /** @type {HTMLElement} */ ([...statusbarWidgets].find(w => w instanceof HTMLElement))
    if (tooltipEl) {
      const tooltipUi = /** @type {teiToolsStatusbarPart} */ (this.createUi(tooltipEl))
      this.#teiHeaderToggleWidget = tooltipUi.teiHeaderToggleWidget
      this.#teiHeaderLabel = tooltipUi.teiHeaderLabel
      xmlEditorApi.addStatusbarWidget(tooltipEl, 'left', 2)
    }

    this.#revisionHistoryBtn = PanelUtils.createButton({
      icon: 'clock-history',
      tooltip: 'Show revision history',
      name: 'revisionHistoryBtn'
    })
    this.#revisionHistoryBtn.style.display = 'none'
    xmlEditorApi.addToolbarWidget(this.#revisionHistoryBtn, 1)

    this.#ui = this.createUi(createSingleFromTemplate('tei-revision-history-drawer', document.body))

    this.#xmlEditorApi.on('editorAfterLoad', () => {
      this.#xmlEditorApi.whenReady().then(() => {
        this.#updateTeiHeaderToggle()
        this.#updateRevisionHistoryButton()
      })
    })
  }

  /** @param {ApplicationState} _state */
  async start(_state) {
    this.getDependency('logger').debug(`Starting plugin "tei-tools"`)

    this.#teiHeaderToggleWidget.addEventListener('sl-change', (event) => {
      const isChecked = event.target.checked
      this.#toggleTeiHeaderVisibility(isChecked)
    })

    this.#revisionHistoryBtn.addEventListener('widget-click', () => {
      this.#showRevisionHistory()
    })

    this.#ui.closeBtn.addEventListener('click', () => {
      this.#ui.hide()
    })
  }

  async onStateUpdate(_changedKeys) {
    const hasDocument = !!this.state.xml
    this.#teiHeaderToggleWidget.disabled = !hasDocument
    this.#teiHeaderLabel.style.opacity = hasDocument ? '1' : '0.5'

    if (!hasDocument) {
      this.#revisionHistoryBtn.style.display = 'none'
    }
  }

  #updateTeiHeaderToggle() {
    const teiHeaderToggleWidget = this.#teiHeaderToggleWidget
    const teiHeaderLabel = this.#teiHeaderLabel
    const hasTeiHeader = !!this.#xmlEditorApi.getDomNodeByXpath('//tei:teiHeader')

    teiHeaderToggleWidget.disabled = !hasTeiHeader
    teiHeaderLabel.style.opacity = hasTeiHeader ? '1' : '0.5'

    if (hasTeiHeader) {
      const preferredVisible = getTeiHeaderVisibilityPreference()
      try {
        if (preferredVisible) {
          this.#xmlEditorApi.unfoldByXpath('//tei:teiHeader')
        } else {
          this.#xmlEditorApi.foldByXpath('//tei:teiHeader')
        }
        teiHeaderToggleWidget.checked = preferredVisible
      } catch (error) {
        this.getDependency('logger').debug(`Error setting teiHeader visibility: ${String(error)}`)
      }
    }
  }

  #updateRevisionHistoryButton() {
    const hasRevisionDesc = !!this.#xmlEditorApi.getDomNodeByXpath('//tei:revisionDesc')
    this.#revisionHistoryBtn.style.display = hasRevisionDesc ? 'inline-flex' : 'none'
  }

  /**
   * @param {boolean} show
   */
  #toggleTeiHeaderVisibility(show) {
    if (!this.#xmlEditorApi.isReady()) return
    try {
      if (show) {
        this.#xmlEditorApi.unfoldByXpath('//tei:teiHeader')
        this.#xmlEditorApi.selectByXpath('//tei:teiHeader')
        this.getDependency('logger').debug('Unfolded teiHeader')
      } else {
        this.#xmlEditorApi.foldByXpath('//tei:teiHeader')
        this.getDependency('logger').debug('Folded teiHeader')
      }
      setTeiHeaderVisibilityPreference(show)
    } catch (error) {
      this.getDependency('logger').warn(`Error toggling teiHeader visibility: ${String(error)}`)
    }
  }

  #showRevisionHistory() {
    if (!this.#xmlEditorApi.isReady()) return
    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) {
      this.getDependency('logger').warn('No XML tree available')
      return
    }

    const changeNodes = Array.from(xmlTree.querySelectorAll('revisionDesc change'))
    if (changeNodes.length === 0) {
      this.getDependency('logger').debug('No revision history found')
      return
    }

    changeNodes.sort((a, b) => {
      const dateA = a.getAttribute('when') || ''
      const dateB = b.getAttribute('when') || ''
      return dateB.localeCompare(dateA)
    })

    const respStmtMap = buildRespStmtMap(xmlTree)
    const tbody = this.#ui.revisionTable.revisionTableBody
    tbody.innerHTML = ''

    changeNodes.forEach((changeNode, index) => {
      const row = document.createElement('tr')
      row.style.borderBottom = '1px solid var(--sl-color-neutral-100)'

      if (index % 2 === 1) {
        row.style.backgroundColor = 'var(--sl-color-neutral-50)'
      }

      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = 'var(--sl-color-neutral-100)'
      })
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = index % 2 === 1 ? 'var(--sl-color-neutral-50)' : ''
      })

      const cellStyle = 'padding: 0.75rem 1rem; color: var(--sl-color-neutral-700);'

      const dateCell = document.createElement('td')
      dateCell.style.cssText = cellStyle + ' font-family: var(--sl-font-mono); font-size: 0.8125rem; white-space: nowrap;'
      dateCell.textContent = this.#formatDate(changeNode.getAttribute('when'))
      row.appendChild(dateCell)

      const descCell = document.createElement('td')
      descCell.style.cssText = cellStyle
      const descNode = changeNode.querySelector('desc')
      descCell.textContent = descNode ? descNode.textContent.trim() : ''
      row.appendChild(descCell)

      const statusCell = document.createElement('td')
      statusCell.style.cssText = cellStyle + ' text-transform: capitalize;'
      const statusAttr = changeNode.getAttribute('status')
      if (statusAttr) {
        statusCell.textContent = statusAttr
        statusCell.style.fontWeight = '500'
        statusCell.style.color = 'var(--sl-color-primary-600)'
      }
      row.appendChild(statusCell)

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

    this.#ui.show()
  }

  /**
   * Formats a date string to YYYY-MM-DD HH:mm:SS format
   * @param {string|null} dateStr
   * @returns {string}
   */
  #formatDate(dateStr) {
    if (!dateStr) return ''
    try {
      const date = new Date(dateStr)
      if (isNaN(date.getTime())) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return `${dateStr} 00:00:00`
        }
        return dateStr
      }
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hours = String(date.getHours()).padStart(2, '0')
      const minutes = String(date.getMinutes()).padStart(2, '0')
      const seconds = String(date.getSeconds()).padStart(2, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    } catch (error) {
      this.getDependency('logger').debug(`Error formatting date: ${String(error)}`)
      return dateStr
    }
  }
}

export default TeiToolsPlugin

export const plugin = TeiToolsPlugin

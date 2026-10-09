/**
 * TEI Tools plugin - provides utilities for working with TEI documents
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlDrawer } from '../ui.js'
 * @import { teiRevisionHistoryDrawerPart } from '../templates/tei-revision-history-drawer.types.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { StatusToggleButton } from '../modules/panels/widgets/status-toggle-button.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'
import { userIsAnnotatorOnly } from '../modules/acl-utils.js'
import ui from '../ui.js'

// Register templates
await registerTemplate('tei-revision-history-drawer', 'tei-revision-history-drawer.html')

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

  /** @type {StatusToggleButton} */
  #headerFoldToggle;

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "tei-tools"`)

    const xmlEditorApi = this.getDependency('xmleditor')

    this.#headerFoldToggle = /** @type {StatusToggleButton} */ (ui.xmlEditor.toolbar.headerGroup.headerFoldToggle)

    this.#revisionHistoryBtn = PanelUtils.createButton({
      icon: 'clock-history',
      tooltip: 'Show revision history',
      name: 'revisionHistoryBtn'
    })
    this.#revisionHistoryBtn.style.display = 'none'
    xmlEditorApi.addToolbarWidget(this.#revisionHistoryBtn, 1)

    this.#ui = this.createUi(createSingleFromTemplate('tei-revision-history-drawer', document.body))

    this.#xmlEditorApi.on('editorAfterLoad', async () => {
      await this.#xmlEditorApi.whenReady()
      this.#updateTeiHeaderToggle()
      this.#updateRevisionHistoryButton()
    })
  }

  /** @param {ApplicationState} _state */
  async start(_state) {
    this.getDependency('logger').debug(`Starting plugin "tei-tools"`)

    this.#headerFoldToggle.addEventListener('widget-change', (event) => {
      this.#toggleTeiHeaderVisibility(/** @type {CustomEvent} */ (event).detail.checked)
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
    const inAnnotationMode = this.state.view === 'annotation'
    const isAnnotatorOnly = userIsAnnotatorOnly(this.state.user)
    this.#headerFoldToggle.disabled = !hasDocument || inAnnotationMode
    // Reduce clutter for pure annotators: the toggle is hidden, not just disabled
    // (docs/superpowers/specs/2026-09-28-annotator-teiheader-safeguard.md). Manual
    // fold/unfold via the gutter remains available regardless.
    this.#headerFoldToggle.style.display = isAnnotatorOnly ? 'none' : ''

    if (!hasDocument) {
      this.#revisionHistoryBtn.style.display = 'none'
    }
  }

  #updateTeiHeaderToggle() {
    const headerFoldToggle = this.#headerFoldToggle
    const hasTeiHeader = !!this.#xmlEditorApi.getDomNodeByXpath('//tei:teiHeader')

    headerFoldToggle.disabled = !hasTeiHeader

    if (hasTeiHeader && this.state.view !== 'annotation') {
      // Pure annotators always get the header folded on load, regardless of the
      // stored preference (and without reading/writing it - the toggle is hidden
      // for this role, so no user-driven change would persist it anyway).
      const isAnnotatorOnly = userIsAnnotatorOnly(this.state.user)
      const preferredVisible = isAnnotatorOnly ? false : this.uiStorage.get('teiHeaderVisible', false)
      try {
        if (preferredVisible) {
          this.#xmlEditorApi.unfoldByXpath('//tei:teiHeader')
        } else {
          this.#xmlEditorApi.foldByXpath('//tei:teiHeader')
        }
        headerFoldToggle.checked = preferredVisible
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
      this.uiStorage.set('teiHeaderVisible', show)
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

/**
 * This component provides inter-plugin orchestration methods
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import ui from '../ui.js'
import { SsePlugin } from '../plugin-registry.js'
import { getFileDataById, getPdfOfArtifact } from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import { resolveDeduplicated } from '../modules/codemirror/codemirror-utils.js'
import { ApiError } from '../modules/utils.js'
import { encodeXmlEntities } from '../modules/tei-utils.js'
import { ServerChangeMonitor } from '../modules/server-change-monitor.js'
import { testLog } from '../modules/test-log.js'

class ServicesPlugin extends Plugin {
  /** @type {import('./logger.js').default} */
  #logger
  /** @type {ReturnType<import('./config.js').default['getApi']>} */
  #config
  /** @type {import('./dialog.js').default} */
  #dialog
  /** @type {import('./client.js').api} */
  #client
  /** @type {import('./access-control.js').default} */
  #accessControl
  /** @type {import('./xmleditor.js').default} */
  #xmlEditor
  /** @type {import('./pdfviewer.js').default} */
  #pdfViewer
  /** @type {import('./tei-validation.js').default} */
  #validation
  /** @type {import('./file-selection.js').default} */
  #fileSelection
  /** @type {ServerChangeMonitor} */
  #serverChangeMonitor
  /** Incremented by every {@link load} of an XML document, to recognize outdated loads */
  #xmlLoadCount = 0
  /** @type {string|null} The XML document of the latest {@link load} */
  #latestXml = null
  /** @type {string|null} stable_id of the PDF in the viewer: `state.pdf`, or the archived original PDF of the loaded version (#924) */
  #shownPdf = null

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'services',
      deps: ['file-selection', 'document-actions', 'logger', 'config', 'dialog', 'client', 'access-control', 'xmleditor', 'pdfviewer', 'tei-validation']
    })
  }

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#logger = this.getDependency('logger')
    this.#config = this.getDependency('config')
    this.#dialog = this.getDependency('dialog')
    this.#client = this.getDependency('client')
    this.#accessControl = this.getDependency('access-control')
    this.#xmlEditor = this.getDependency('xmleditor')
    this.#pdfViewer = this.getDependency('pdfviewer')
    this.#validation = this.getDependency('tei-validation')
    this.#fileSelection = this.getDependency('file-selection')

    // Listen for maintenance mode events
    SsePlugin.getInstance().addEventListener('maintenanceOn', async (event) => {
      const data = JSON.parse(event.data)
      await this.dispatchStateChange({ maintenanceMode: true })
      ui.spinner.show(data.message || '')
    })

    SsePlugin.getInstance().addEventListener('maintenanceOff', async (event) => {
      ui.spinner.hide()
      await this.dispatchStateChange({ maintenanceMode: false })
      const data = JSON.parse(event.data)
      if (data.message) {
        this.#dialog.info(data.message)
      }
    })

    SsePlugin.getInstance().addEventListener('maintenanceReload', () => {
      window.location.reload()
    })

    // Reload when a backup was restored or the plugins were changed (see server-change-monitor.js)
    this.#serverChangeMonitor = new ServerChangeMonitor({
      fetchStatus: () => this.#client.apiClient.maintenanceStatus(),
      reload: () => window.location.reload(),
      storage: getSessionStorage(),
      logger: this.#logger
    })
    SsePlugin.getInstance().addEventListener('serverChanged', () => this.#serverChangeMonitor.check())
    SsePlugin.getInstance().onConnectionChange(() => this.#serverChangeMonitor.check())

    // Listen for lock release events to attempt acquiring locks for read-only documents
    SsePlugin.getInstance().addEventListener('lockReleased', async (event) => {
      const data = JSON.parse(event.data)
      const releasedStableId = data.stable_id

      // Check if we're currently viewing this document in read-only mode
      if (this.state.xml === releasedStableId && this.state.editorReadOnly) {
        this.#logger.debug(`Lock released for current document ${releasedStableId}, attempting to acquire`)

        try {
          // Try to acquire the lock (first client wins)
          await this.#client.acquireLock(releasedStableId)
          this.#logger.info(`Successfully acquired lock for ${releasedStableId}`)

          notify('You can now edit this document', 'success', 'unlock')
          await this.load({ xml: releasedStableId })
          await this.dispatchStateChange({ editorReadOnly: false })

        } catch (error) {
          if (error instanceof this.#client.LockedError) {
            this.#logger.debug(`Lock already acquired by another client for ${releasedStableId}`)
            // Another client got the lock first, stay in read-only mode
          } else {
            this.#logger.error(`Failed to acquire lock for ${releasedStableId}: ${error}`)
          }
        }
      }
    })
  }

  async start() {
    const notice = await this.#serverChangeMonitor.init()
    if (notice) this.#dialog.info(notice)
  }

  /**
   * Postpones the automatic reload after server-side changes (restored backup, changed
   * plugins), e.g. while the plugin manager is open. Releasing the hold reloads the page if
   * the server changed in the meantime.
   * @param {boolean} held
   * @returns {Promise<void>}
   */
  holdServerChangeReload(held) {
    return this.#serverChangeMonitor.hold(held)
  }

  /**
   * Called when the application is shutting down (beforeunload)
   * Release any file locks held by this session
   */
  async shutdown() {
    if (this.state?.xml && !this.state?.editorReadOnly) {
      try {
        await this.#client.releaseLock(this.state.xml)
        this.#logger.debug(`Released lock for file ${this.state.xml} during shutdown`)
      } catch (error) {
        // Don't throw during shutdown - just log the error
        console.warn('Failed to release lock during shutdown:', String(error))
      }
    }
  }

  /**
   * Shows another PDF of the open document in the viewer, at the page shown before, and makes it
   * `state.pdf`, without reloading the XML document. Used when the open version was attached to
   * another PDF, e.g. after writing text corrections of some pages into the PDF.
   * @param {string} pdf - stable_id of the PDF
   * @returns {Promise<void>}
   */
  async showPdf(pdf) {
    const page = this.#pdfViewer.pdfViewer?.currentPageNumber ?? 1
    this.#shownPdf = pdf
    await this.#pdfViewer.load(`/api/files/${pdf}`)
    testLog('PDF_SHOWN', { pdf })
    await this.#pdfViewer.pagesLoadedPromise
    if (this.#pdfViewer.pdfDoc && page > 1 && page <= this.#pdfViewer.pdfDoc.numPages) {
      await this.#pdfViewer.goToPage(page)
    }
    await this.dispatchStateChange({ pdf })
  }

  /**
   * Loads the given XML and/or PDF file(s) into the editor and viewer. If another XML document is
   * loaded before this load completes, the outdated XML document is not made the current one.
   * @param {{xml?: string | null, pdf?: string | null}} files An Object with one or more of the keys "xml" and "pdf"
   */
  async load({ xml, pdf }) {
    const xmlLoad = xml ? ++this.#xmlLoadCount : 0
    if (xml) this.#latestXml = xml

    // Signal loading state to disable selectboxes
    await this.context.invokePluginEndpoint(ep.filedata.loading, true)

    try {
      // Capture current state at call time before any changes
      const currentState = this.state
      const stateChanges = {}

      const promises = []
      let file_is_locked = false

      // PDF. A version is shown with the PDF it is attached to, which becomes `state.pdf` (#944)
      const ownPdf = xml ? getPdfOfArtifact(currentState.fileData, xml) : null
      if (ownPdf) pdf = (pdf || ownPdf !== currentState.pdf) ? ownPdf : null
      const viewerPdf = pdf ?? (xml && this.#shownPdf !== currentState.pdf ? currentState.pdf : null)
      if (pdf) {
        await this.dispatchStateChange({ pdf: null, xml: null, diff: null })
      }
      if (pdf || (viewerPdf && viewerPdf !== this.#shownPdf)) {
        this.#logger.info("Loading PDF: " + viewerPdf)
        // Convert document identifier to static file URL
        const pdfUrl = `/api/files/${viewerPdf}` // TODO unhardcode this!
        this.#shownPdf = viewerPdf
        promises.push(this.#pdfViewer.load(pdfUrl))
        testLog('PDF_SHOWN', { pdf: viewerPdf })
      }

      // XML
      if (xml) {
        // Always check for lock before loading, even if file is already in state
        // (e.g., when opening same URL in new tab with sessionStorage containing stale state)
        const isNewFile = currentState.xml !== xml;

        try {
          ui.spinner.show('Loading file, please wait...')

          // Release previous lock if we're switching files
          if (isNewFile && currentState.xml && !currentState.editorReadOnly) {
            await this.#client.releaseLock(currentState.xml)
          }

          // Check access control before attempting to acquire lock
          const canEdit = this.#accessControl.checkCanEditFile(xml)
          if (!canEdit) {
            this.#logger.debug(`User does not have edit permission for file ${xml}, loading in read-only mode`)
            file_is_locked = true
          } else {
            try {
              await this.#client.acquireLock(xml)
              this.#logger.debug(`Acquired lock for file ${xml}`)
            } catch (error) {
              if (error instanceof this.#client.LockedError) {
                this.#logger.debug(`File ${xml} is locked (holder: ${error.detail?.holder ?? 'unknown'}), loading in read-only mode`)
                file_is_locked = true
                notify(
                  error.detail?.message ?? 'This document is being edited by another user',
                  'warning',
                  error.detail?.holder === 'user' ? 'exclamation-triangle' : 'lock'
                )
              } else if (error instanceof this.#client.ApiError && error.statusCode === 403) {
                // Permission denied - load in read-only mode
                this.#logger.debug(`No edit permission for file ${xml}, loading in read-only mode`)
                file_is_locked = true
                // In owner-based mode the access-control plugin shows a more specific notification
                if (this.#accessControl.getMode() !== 'owner-based') {
                  notify(
                    'You do not have permission to edit this document.',
                    'warning',
                    'lock'
                  )
                }
              } else {
                const errorMessage = String(error)
                this.#dialog.error(errorMessage)
                throw error
              }
            }
          }
        } finally {
          ui.spinner.hide()
        }

        // Always load XML content and update state. The merge view of the previous document ends;
        // the editor's own merge view is hidden too, in case it was shown without the merge-view plugin
        await this.context.invokePluginEndpoint(ep.mergeView.hide, [], { throws: true })
        await this.#xmlEditor.hideMergeView()
        await this.dispatchStateChange({
          xml: null,
          diff: null,
          editorReadOnly: file_is_locked,
          xpath: null
        })
        this.#logger.info(`Loading XML: ${xml} (read-only: ${file_is_locked})`)
        // Convert document identifier to static file URL
        const xmlUrl = `/api/files/${xml}`
        promises.push(this.#xmlEditor.loadXml(xmlUrl))
      }

      // await promises in parallel
      try {
        await Promise.all(promises)
      } catch (error) {
        if (error instanceof ApiError) {
          // @ts-ignore
          if (error.status === 404) {
            this.#logger.warn(String(error))
            await this.#fileSelection.reload()
            return
          }
        }
        throw error
      }

      if (xml && xmlLoad !== this.#xmlLoadCount) {
        // A newer load started meanwhile: the editor shows its document (see XMLEditor.loadXml)
        this.#logger.debug(`Load of ${xml} was superseded by a newer load`)
        if (!file_is_locked && this.#latestXml !== xml) {
          await this.#client.releaseLock(xml).catch(/** @param {unknown} error */ error => {
            this.#logger.warn(`Could not release the lock of ${xml}: ${String(error)}`)
          })
        }
        xml = null
      }

      if (pdf) {
        stateChanges.pdf = pdf
      }
      if (xml) {
        stateChanges.xml = xml
        // call asynchronously, don't block the editor
        this.#startAutocomplete().then(result => {
          result && this.#logger.info("Autocomplete is available")
        })
      }

      // Set collection and variant based on loaded documents
      if (currentState.fileData && (pdf || xml)) {
        for (const file of currentState.fileData) {
          const fileData = /** @type {any} */ (file)

          let foundMatch = false

          // Check source id
          if (pdf && fileData.source && fileData.source.id === pdf) {
            foundMatch = true
          }

          // Check XML id in artifacts (don't skip this even if PDF was found)
          if (xml) {
            const matchingArtifact = fileData.artifacts && fileData.artifacts.find(/** @param {any} artifact */ artifact => artifact.id === xml)
            if (matchingArtifact) {
              // Always set variant from artifact (it's the source of truth for the loaded document)
              if (matchingArtifact.variant) {
                stateChanges.variant = matchingArtifact.variant
              }
              foundMatch = true
            }
          }

          // Only break if we found what we're looking for
          if (foundMatch) {
            Object.assign(stateChanges, this.#getCollectionChanges(currentState, fileData.collections || []))
            break
          }
        }
      }

      // notify plugins
      await this.dispatchStateChange(stateChanges)
    } finally {
      // Clear loading state
      await this.context.invokePluginEndpoint(ep.filedata.loading, false)
    }
  }

  /**
   * Returns the state changes that make the collection state match the loaded document: `collection`
   * (and `project`) if the current collection is not one of the document's, and `collectionFilter` if
   * the file selection is filtered by a collection that does not contain the document (e.g. a filter
   * restored from the session when the document comes from the URL hash), which would otherwise hide
   * the document in the selectboxes.
   * @param {ApplicationState} currentState
   * @param {string[]} docCollections - The collections of the loaded document
   * @returns {Partial<ApplicationState>}
   */
  #getCollectionChanges(currentState, docCollections) {
    /** @type {Partial<ApplicationState>} */
    const changes = {}
    if (docCollections.length === 0) return changes
    const filter = currentState.collectionFilter
    if (filter && !docCollections.includes(filter)) {
      changes.collectionFilter = docCollections[0]
    }
    if (!currentState.collection || !docCollections.includes(currentState.collection)) {
      const collection = changes.collectionFilter || docCollections[0]
      const project = (currentState.projects || []).find(p => p.collections && p.collections.includes(collection))
      changes.collection = collection
      changes.project = project ? project.id : null
    }
    return changes
  }

  async #startAutocomplete() {
    // Load autocomplete data asynchronously after XML is loaded
    try {
      this.#logger.debug("Loading autocomplete data for XML document")
      const xmlContent = this.#xmlEditor.getEditorContent()
      if (xmlContent) {
        const hasXsdSchema = /schemaLocation="[^"]+"/.test(xmlContent)
        const hasRelaxNG = /<\?xml-model\s[^>]*schematypens="http:\/\/relaxng\.org\/ns\/structure\/1\.0"[^>]*\?>/.test(xmlContent)
        if (!hasXsdSchema && !hasRelaxNG) {
          this.#logger.info("No schema declaration found in XML document, skipping autocomplete")
          return true
        }
        try {
          const invalidateCache = this.state?.hasInternet
          const autocompleteData = await this.#client.getAutocompleteData(xmlContent, invalidateCache)

          // Resolve deduplicated references
          const resolvedData = resolveDeduplicated(autocompleteData)

          // Start autocomplete with the resolved data
          this.#xmlEditor.startAutocomplete(resolvedData)
          this.#logger.debug("Autocomplete data loaded and applied")
        } catch (error) {
          if (error instanceof ApiError) {
            this.#logger.info("No autocomplete data available: " + String(error))
          } else {
            throw error
          }
        }
      }
      return true
    } catch (error) {
      const errorMessage = String(error)
      this.#logger.warn("Failed to load autocomplete data: " + errorMessage)
      return false
    }
  }

  /**
   * Validates the XML document by calling the validation service
   * @returns {Promise<object[]>}
   */
  async validateXml() {
    this.#logger.info("Validating XML...")
    return await this.#validation.validate() // todo use endpoint instead
  }

  /**
   * Downloads the current XML file
   * @param {ApplicationState} state
   */
  async downloadXml(state) {
    if (!state.xml) {
      throw new TypeError("State does not contain an xml path")
    }
    let xml = this.#xmlEditor.getXML()
    if (await this.#config.get('xml.encode-entities.server')) {
      const encodeQuotes = await this.#config.get('xml.encode-quotes', false)
      xml = encodeXmlEntities(xml, { encodeQuotes })
    }
    const blob = new Blob([xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url

    const fileData = getFileDataById(state.xml)
    let filename = fileData?.file?.doc_id || state.xml

    // Add variant name to filename if variant exists
    // The item could be a version or gold file which has variant
    const variant = fileData?.item?.variant
    if (variant) {
      // Variants of an extractor may be prefixed with its id ("<extractor>.training.segmentation");
      // the prefix is dropped from the filename
      let variantName = variant
      try {
        const extractors = await this.#client.getExtractorList()
        const extractor = extractors.find(e => variant.startsWith(`${e.id}.`))
        if (extractor) variantName = variant.slice(extractor.id.length + 1)
      } catch (error) {
        this.#logger.warn('Could not load extractor list: ' + String(error))
      }
      filename = `${filename}.${variantName}`
    }

    a.download = `${filename}.tei.xml`

    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Uploads an XML file, creating a new version for the currently selected document
   * @param {ApplicationState} state
   */
  async uploadXml(state) {
    const uploadResult = await this.#client.uploadFile(undefined, { accept: '.xml' })
    const tempFilename = /** @type {any} */ (uploadResult).filename
    // @ts-ignore
    const { path } = await this.#client.createVersionFromUpload(tempFilename, state.xml)
    await this.#fileSelection.reload()
    await this.load({ xml: path })
    notify("Document was uploaded. You are now editing the new version.")
  }

  /**
   * Given a node in the XML, locates and highlights the region of the PDF
   * it was extracted from. The lookup is done by the handlers of the
   * `pdfSearch.searchNode` extension point (see EditorSyncPlugin).
   * @param {Element} node
   * @returns {Promise<void>}
   */
  async searchNodeContentsInPdf(node) {
    await this.context.invokePluginEndpoint(ep.pdfSearch.searchNode, [node], { throws: true, result: 'values' })
  }
}

export default ServicesPlugin


/**
 * The session storage, or null where it is not accessible (e.g. blocked site data).
 * @returns {Storage|null}
 */
function getSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

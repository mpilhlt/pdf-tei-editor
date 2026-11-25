/**
 * This implements the UI for the file selection
 */


/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect } from '../ui.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { PanelContribution } from '../modules/panels/base-panel.js'
 */
import { SlOption, SlDivider } from '../ui.js'
import { registerTemplate, createFromTemplate, createHtmlElements } from '../modules/ui-system.js'
import Plugin from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { groupFilesByCollection, getCollectionName, pickDocumentCollection } from '../modules/file-data-utils.js'
import { getActiveProjects, getArchivedCollectionIds, compareCollectionNames } from '../modules/collection-utils.js'
import { filterFileData, getFileIdentifier, getSelectedFileVersions, appendVersionOptions } from '../modules/version-options.js'

// Register templates
await registerTemplate('file-selection', 'file-selection.html');

class FileSelectionPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'file-selection',
      deps: ['logger', 'dialog', 'filedata']
    });
  }

  static extensionPoints = [ep.filedata.loading, ep.toolbar.contentItems, ep.rbac.collectionRenamed];

  /**
   * Extension point handler for `ep.rbac.collectionRenamed`.
   * Called by RbacManagerPlugin after an admin renamed a collection id, so that a collection
   * filter on the old id follows the rename.
   * Delegates to {@link FileSelectionPlugin#onCollectionRenamed}.
   * @param {string} oldId
   * @param {string} newId
   * @returns {Promise<void>}
   */
  [ep.rbac.collectionRenamed](oldId, newId) { return this.onCollectionRenamed(oldId, newId) }

  /**
   * Replaces the collection filter if it names a renamed collection.
   * @param {string} oldId - The previous collection id
   * @param {string} newId - The new collection id
   * @returns {Promise<void>}
   */
  async onCollectionRenamed(oldId, newId) {
    if (this.state.collectionFilter === oldId) {
      await this.dispatchStateChange({ collectionFilter: newId });
    }
  }

  /**
   * Extension point handler for `ep.filedata.loading`.
   * Called when a file load operation starts or ends, so the select boxes
   * can be put into / taken out of loading state and repopulated on completion.
   * Delegates to {@link FileSelectionPlugin#loading}.
   * @param {boolean} isLoading
   * @returns {Promise<void>}
   */
  [ep.filedata.loading](...args) { return this.loading(...args) }

  /**
   * Extension point handler for `ep.toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's toolbar contributions.
   * Returns the four file-selection controls in the order Collection, Model Variant, Source File,
   * Target XML (`order`, left of "Compare with version" of the merge-view plugin at 10 and the
   * Document actions at 8). On overflow, Collection and Model Variant are hidden first and Source File
   * and Target XML last (`priority`).
   * @returns {PanelContribution[]}
   */
  [ep.toolbar.contentItems]() {
    /** @type {Record<string, {order: number, priority: number}>} */
    const placement = {
      collection: { order: 14, priority: 5 },
      variant: { order: 13, priority: 5 },
      pdf: { order: 12, priority: 10 },
      xml: { order: 11, priority: 10 }
    }
    return [this.#collection, this.#variant, this.#pdf, this.#xml]
      .filter(Boolean)
      .map(el => ({ element: el, ...(placement[el.getAttribute('name') ?? ''] ?? { order: 1, priority: 1 }), position: 'center' }))
  }

  get #logger() { return this.getDependency('logger') }
  get #dialog() { return this.getDependency('dialog') }

  // Own toolbar elements — set during install()
  /** @type {import('../ui.js').SlSelect} */ #pdf
  /** @type {import('../ui.js').SlSelect} */ #xml
  /** @type {import('../ui.js').SlSelect} */ #variant
  /** @type {import('../ui.js').SlSelect} */ #collection

  // Private state
  /** @type {Set<string>} */
  #variants;
  #collections;
  /** @type {Promise<void>|null} The running population of the selectboxes, if any */
  #populateRun = null;
  /** Whether the selectboxes must be populated again once the running population ends */
  #populatePending = false;
  #isFileLoading = false;
  /** @type {Set<EventTarget>} Selects that were opened by the user; gates sl-change handling */
  #userOpenedDropdown = new Set();

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    for (const control of createFromTemplate('file-selection')) {
      if (!(control instanceof HTMLElement)) continue
      switch (control.getAttribute('name')) {
        case 'pdf':        this.#pdf        = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'xml':        this.#xml        = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'variant':    this.#variant    = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'collection': this.#collection = /** @type {import('../ui.js').SlSelect} */ (control); break
      }
    }

  }

  async start() {
    /** @type {[SlSelect, string, function(string): Promise<void>][]} */
    const handlers = [
      [this.#collection, 'collection', (v) => this.#onChangeCollectionSelection(v)],
      [this.#variant,    'variant',    (v) => this.#onChangeVariantSelection(v)],
      [this.#pdf,        'pdf',        (v) => this.#onChangePdfSelection(v)],
      [this.#xml,        'xml',        (v) => this.#onChangeXmlSelection(v)]
    ];

    for (const [select, , handler] of handlers) {
      select.addEventListener('sl-show', () => {
        this.#userOpenedDropdown.add(select);
        select.closest('tool-bar')?.classList.add('dropdown-open');
      });

      select.addEventListener('sl-change', async () => {
        if (!this.#userOpenedDropdown.has(select)) return;
        this.#userOpenedDropdown.delete(select);
        await handler(select.value);
      });

      select.addEventListener('sl-hide', () => {
        setTimeout(() => {
          this.#userOpenedDropdown.delete(select);
          if (this.#userOpenedDropdown.size === 0) {
            select.closest('tool-bar')?.classList.remove('dropdown-open');
          }
        }, 0);
      });
    }
  }

  /**
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    if ((changedKeys.includes('collections') || changedKeys.includes('projects')) && state.collections) {
      await this.#populateCollectionSelectbox(state);
    }

    if (changedKeys.some(k => ['xml', 'pdf', 'variant', 'fileData', 'collectionFilter', 'projects'].includes(k)) && state.fileData) {
      // Schedule outside the state propagation window: #populateSelectboxes has many async
      // steps that can take seconds for large file lists, and holding #isUpdatingState=true
      // that long blocks user interactions from dispatching their own state changes.
      setTimeout(() => {
        this.#requestPopulate().catch(e => this.#logger.error(String(e)));
      }, 0);
    } else {
      this.#updateSelectboxValues(state);
    }
  }

  /**
   * Extension point: called when file loading starts/ends
   * @param {boolean} isLoading
   */
  async loading(isLoading) {
    this.#isFileLoading = isLoading;
    this.#setSelectboxLoadingState(isLoading);
    if (!isLoading && this.state?.fileData) {
      await this.#requestPopulate();
    }
  }

  /**
   * Reloads file data
   * @param {Object} [options]
   * @param {boolean} [options.refresh]
   */
  async reload(options = {}) {
    await this.getDependency('filedata').reload(options);
    // Populating the selectboxes on the fileData change is deferred (see onStateUpdate), so
    // populate them here: callers read the options right after reloading, e.g. to load the
    // next version after deleting one, and must not see deleted files.
    await this.#requestPopulate();
  }

  /**
   * Returns the current options for the given select element.
   * @param {'xml'|'pdf'} type
   * @returns {{value: string, label: string, isGold: boolean}[]}
   */
  getOptionValues(type) {
    const select = { xml: this.#xml, pdf: this.#pdf }[type]
    if (!select) return []
    return Array.from(select.querySelectorAll('sl-option')).map(opt => ({
      value: /** @type {any} */ (opt).value,
      label: /** @type {SlOption} */ (opt).getTextLabel(),
      isGold: /** @type {HTMLElement} */ (opt).dataset.gold === 'true'
    }))
  }

  /**
   * Returns the version to load when no version is selected: the gold version if the "Target XML"
   * menu lists one, otherwise its first version.
   * @returns {string|undefined}
   */
  getDefaultVersion() {
    const options = this.getOptionValues('xml')
    return (options.find(o => o.isGold) || options[0])?.value
  }

  //
  // Private methods
  //

  /** @param {ApplicationState} state */
  #updateSelectboxValues(state) {
    let sourceValue = state.pdf || "";
    if (!state.pdf && state.xml && state.fileData) {
      const xmlFile = state.fileData.find(file =>
        file.artifacts && file.artifacts.some(a => a.id === state.xml)
      );
      if (xmlFile && !xmlFile.source) {
        sourceValue = state.xml;
      }
    }
    this.#pdf.value = sourceValue;
    this.#xml.value = state.xml || "";
    this.#collection.value = state.collectionFilter || "";
  }

  /** @param {boolean} isLoading */
  #setSelectboxLoadingState(isLoading) {
    const selectboxes = [
      this.#pdf, this.#xml,
      this.#variant, this.#collection
    ];
    for (const select of selectboxes) {
      if (isLoading) {
        select.disabled = true;
        select.classList.add('loading');
      } else {
        select.disabled = false;
        select.classList.remove('loading');
      }
    }
  }

  /** @param {ApplicationState} state */
  async #populateCollectionSelectbox(state) {
    if (!state.collections) return;

    this.#collection.innerHTML = "";

    const allOption = new SlOption();
    allOption.value = "";
    allOption.textContent = "All";
    // @ts-ignore
    allOption.size = "small";
    this.#collection.appendChild(allOption);

    const projects = getActiveProjects(state.projects || []);
    const archivedCollectionIds = getArchivedCollectionIds(state.projects || []);
    const assignedCollectionIds = new Set(
      projects.flatMap(p => p.collections || [])
    );

    // Render each project header followed by its collections
    for (const project of projects) {
      const header = new SlOption();
      header.value = `__project__${project.id}`;
      header.disabled = true;
      header.innerHTML = `<small>${project.name}</small>`;
      this.#collection.appendChild(header);

      const projectCollections = (project.collections || [])
        .map(colId => (state.collections || []).find(c => c.id === colId))
        .filter(Boolean);

      for (const collection of projectCollections) {
        const option = new SlOption();
        option.value = collection.id;
        option.textContent = collection.name;
        // @ts-ignore
        option.size = "small";
        this.#collection.appendChild(option);
      }
    }

    // Render orphan collections (not in any project) at the end
    const orphans = (state.collections || []).filter(
      c => !assignedCollectionIds.has(c.id) && !archivedCollectionIds.has(c.id)
    );
    if (orphans.length > 0 && projects.length > 0) {
      const otherHeader = new SlOption();
      otherHeader.value = '__other__';
      otherHeader.disabled = true;
      otherHeader.innerHTML = '<small>Other</small>';
      this.#collection.appendChild(otherHeader);
    }
    for (const collection of orphans) {
      const option = new SlOption();
      option.value = collection.id;
      option.textContent = collection.name;
      // @ts-ignore
      option.size = "small";
      this.#collection.appendChild(option);
    }

    this.#collection.value = state.collectionFilter || "";
  }

  /** @param {ApplicationState} state */
  async #populateVariantSelectbox(state) {
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");

    this.#variant.innerHTML = "";
    this.#variants = new Set();
    state.fileData.forEach(file => {
      if (file.artifacts) {
        file.artifacts.forEach(artifact => {
          if (artifact.variant) this.#variants.add(artifact.variant);
        });
      }
    });

    const allOption = new SlOption();
    allOption.value = "";
    allOption.textContent = "All";
    // @ts-ignore
    allOption.size = "small";
    this.#variant.appendChild(allOption);

    const noneOption = new SlOption();
    noneOption.value = "none";
    noneOption.textContent = "None";
    // @ts-ignore
    noneOption.size = "small";
    this.#variant.appendChild(noneOption);

    [...this.#variants].sort().forEach(variant => {
      const option = new SlOption();
      option.value = variant;
      option.textContent = variant;
      // @ts-ignore
      option.size = "small";
      this.#variant.appendChild(option);
    });

    this.#variant.value = state.variant || "";
  }

  /**
   * Populates the selectboxes from the current state. Populations do not overlap: a request
   * during a running population makes it run once more when it ends, with the state of then,
   * and the returned promise resolves after that run.
   * @returns {Promise<void>}
   */
  #requestPopulate() {
    if (this.#populateRun) {
      this.#populatePending = true;
      return this.#populateRun;
    }
    this.#populateRun = (async () => {
      try {
        do {
          this.#populatePending = false;
          await this.#populateSelectboxes(this.state);
        } while (this.#populatePending);
      } finally {
        this.#populateRun = null;
      }
    })();
    return this.#populateRun;
  }

  /**
   * Populates the selectboxes. Only called through `#requestPopulate()`.
   * @param {ApplicationState} state
   */
  async #populateSelectboxes(state) {
    if (this.#isFileLoading) {
      this.#logger.debug("Ignoring populateSelectboxes request - file loading in progress");
      return;
    }
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");

    this.#logger.debug("Populating selectboxes");
    this.#setSelectboxLoadingState(true);

    try {
      await this.#populateVariantSelectbox(state);

      for (const select of [this.#pdf, this.#xml]) {
        select.innerHTML = "";
      }

      if (state.fileData.length === 0) {
        this.#logger.debug("No files to display, selectboxes cleared");
        return;
      }

      const filteredFileData = filterFileData(state);
      const grouped_files = groupFilesByCollection(filteredFileData);
      this.#collections = Object.keys(grouped_files).sort((a, b) => {
        if (a === "__unfiled") return -1;
        if (b === "__unfiled") return 1;
        return compareCollectionNames(getCollectionName(a, state.collections), getCollectionName(b, state.collections));
      });
      this.#pdf.dataset.collections = JSON.stringify(this.#collections);

      for (const collection_name of this.#collections) {
        const displayName = getCollectionName(collection_name, state.collections);
        await createHtmlElements(`<small>${displayName}</small>`, this.#pdf);

        const files = grouped_files[collection_name].sort((a, b) => {
          const aLabel = a.source?.label || a.doc_metadata?.title || a.doc_id;
          const bLabel = b.source?.label || b.doc_metadata?.title || b.doc_id;
          return (aLabel < bLabel) ? -1 : (aLabel > bLabel) ? 1 : 0;
        });

        for (const file of files) {
          const fileIdentifier = getFileIdentifier(file);
          if (!fileIdentifier) continue;
          const displayLabel = file.source ? file.source.label : `📄 ${file.doc_metadata?.title || file.doc_id}`;

          const option = Object.assign(new SlOption, {
            value: fileIdentifier,
            textContent: displayLabel,
            size: "small",
          });
          option.dataset.doc_id = file.doc_id;
          option.dataset.collections = JSON.stringify(file.collections);
          this.#pdf.hoist = true;
          this.#pdf.appendChild(option);
        }
        this.#pdf.appendChild(new SlDivider());
      }

      // the versions of the selected document (the merge-view plugin lists the same ones)
      appendVersionOptions(this.#xml, getSelectedFileVersions(filteredFileData, state), state.variant);

      // Update selected values after options are in the DOM
      this.#updateSelectboxValues(state);
    } finally {
      this.#setSelectboxLoadingState(false);
    }
  }

  /** @param {string} selectedIdentifier */
  async #onChangePdfSelection(selectedIdentifier) {
    const state = this.state;
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");
    const selectedFile = state.fileData.find(file => {
      if (file.source && file.source.id === selectedIdentifier) return true;
      if (file.artifacts && file.artifacts.some(a => a.id === selectedIdentifier)) return true;
      return false;
    });

    if (!selectedFile) return;

    const collection = pickDocumentCollection(selectedFile.collections, state.collection, state.collectionFilter);
    let pdf = null, xml = null;

    if (selectedFile.source && selectedFile.source.id === selectedIdentifier) {
      if (selectedFile.source.file_type === 'pdf') {
        pdf = selectedIdentifier;
      } else {
        xml = selectedIdentifier;
      }
    } else {
      xml = selectedIdentifier;
    }

    if (pdf && selectedFile.artifacts) {
      const { variant } = state;
      let matchingGold;
      if (variant === "none") {
        matchingGold = selectedFile.artifacts.find(a => a.is_gold_standard && !a.variant);
      } else if (variant && variant !== "") {
        matchingGold = selectedFile.artifacts.find(a => a.is_gold_standard && a.variant === variant);
      } else {
        matchingGold = selectedFile.artifacts.find(a => a.is_gold_standard);
      }
      xml = matchingGold?.id;
    }

    const filesToLoad = {};
    if (pdf && pdf !== state.pdf) filesToLoad.pdf = pdf;
    if (xml && xml !== state.xml) filesToLoad.xml = xml;

    if (Object.keys(filesToLoad).length > 0) {
      try {
        await this.#hideMergeView();
        const owningProject = (state.projects || []).find(p => p.collections && p.collections.includes(collection));
        const stateUpdate = { collection, project: owningProject ? owningProject.id : null };
        if (pdf) {
          stateUpdate.pdf = pdf;
        } else {
          stateUpdate.pdf = null;
        }
        // scheduleStateChange defers if another propagation is still running (e.g. a slow
        // plugin held #isUpdatingState=true when the user clicked), otherwise dispatches immediately.
        await this.scheduleStateChange(stateUpdate);
        await this.getDependency('services').load(filesToLoad);
      } catch (error) {
        this.#logger.error(String(error));
        await this.scheduleStateChange({ collection: null, pdf: null, xml: null });
        await this.reload({ refresh: true });
      }
    }
  }

  /** @param {string} xml */
  async #onChangeXmlSelection(xml) {
    const state = this.state;
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");
    if (!xml || xml === state.xml) return;
    try {
      for (const file of state.fileData) {
        if (file.artifacts && file.artifacts.some(a => a.id === xml)) {
          const _selCollection = pickDocumentCollection(file.collections, state.collection, state.collectionFilter);
          const _selProject = (state.projects || []).find(
            p => p.collections && p.collections.includes(_selCollection)
          );
          await this.scheduleStateChange({
            collection: _selCollection,
            project: _selProject ? _selProject.id : null
          });
          break;
        }
      }
      await this.#hideMergeView();
      await this.getDependency('services').load({ xml });
      await this.scheduleStateChange({ xml });
    } catch (error) {
      this.#logger.error(String(error));
      await this.reload({ refresh: true });
      await this.scheduleStateChange({ xml: null });
      this.#dialog.error(String(error));
    }
  }

  /**
   * Hides the merge view, if the merge-view plugin is active
   * @returns {Promise<void>}
   */
  async #hideMergeView() {
    await this.context.invokePluginEndpoint(ep.mergeView.hide, [], { throws: true });
  }

  /** @param {string} variant */
  async #onChangeVariantSelection(variant) {
    await this.scheduleStateChange({ variant, xml: null });
  }

  /** @param {string} collectionFilter */
  async #onChangeCollectionSelection(collectionFilter) {
    const state = this.state;
    const collection = collectionFilter || null;
    const matchedProject = (state.projects || []).find(
      p => p.collections && p.collections.includes(collectionFilter)
    );
    const project = matchedProject ? matchedProject.id : null;

    let shouldClearSelection = false;
    if (collectionFilter && state.pdf && state.fileData) {
      const currentFile = state.fileData.find(file =>
        file.source && file.source.id === state.pdf
      );
      if (currentFile && !currentFile.collections.includes(collectionFilter)) {
        shouldClearSelection = true;
      }
    }

    if (shouldClearSelection) {
      await this.#hideMergeView();
      await this.scheduleStateChange({ collectionFilter, collection, project, pdf: null, xml: null, diff: null });
    } else {
      await this.scheduleStateChange({ collectionFilter, collection, project });
    }
  }
}

export default FileSelectionPlugin;


/** @deprecated Use FileSelectionPlugin class directly */
export const plugin = FileSelectionPlugin;

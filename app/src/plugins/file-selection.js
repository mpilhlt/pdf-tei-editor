/**
 * This implements the UI for the file selection
 */


/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect } from '../ui.js'
 * @import { DocumentItem, Artifact } from '../modules/file-data-utils.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */
import { SlOption, SlDivider } from '../ui.js'
import { registerTemplate, createFromTemplate, createHtmlElements } from '../modules/ui-system.js'
import Plugin from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { groupFilesByCollection, getCollectionName } from '../modules/file-data-utils.js'

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

  static extensionPoints = [ep.filedata.loading, ep.toolbar.contentItems];

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
   * Returns all five file-selection controls with their individual priorities.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  [ep.toolbar.contentItems]() {
    const priorities = { collection: 12, variant: 11, pdf: 10, xml: 10, diff: 10 }
    return [this.#pdf, this.#xml, this.#diff, this.#variant, this.#collection]
      .filter(Boolean)
      .map(el => ({ element: el, priority: priorities[el.getAttribute('name')] || 1, position: 'center' }))
  }

  get #logger() { return this.getDependency('logger') }
  get #dialog() { return this.getDependency('dialog') }

  // Own toolbar elements — set during install()
  /** @type {import('../ui.js').SlSelect} */ #pdf
  /** @type {import('../ui.js').SlSelect} */ #xml
  /** @type {import('../ui.js').SlSelect} */ #diff
  /** @type {import('../ui.js').SlSelect} */ #variant
  /** @type {import('../ui.js').SlSelect} */ #collection

  // Private state
  /** @type {Set<string>} */
  #variants;
  #collections;
  #isUpdatingProgrammatically = false;
  #isInStateUpdateCycle = false;
  #isPopulatingSelectboxes = false;
  #isFileLoading = false;
  #openDropdownCount = 0;

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    for (const control of createFromTemplate('file-selection')) {
      if (!(control instanceof HTMLElement)) continue
      switch (control.getAttribute('name')) {
        case 'pdf':        this.#pdf        = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'xml':        this.#xml        = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'diff':       this.#diff       = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'variant':    this.#variant    = /** @type {import('../ui.js').SlSelect} */ (control); break
        case 'collection': this.#collection = /** @type {import('../ui.js').SlSelect} */ (control); break
      }
    }

    /** @type {[SlSelect, function][]} */
    const handlers = [
      [this.#collection, () => this.#onChangeCollectionSelection()],
      [this.#variant,    () => this.#onChangeVariantSelection()],
      [this.#pdf,        () => this.#onChangePdfSelection()],
      [this.#xml,        () => this.#onChangeXmlSelection()],
      [this.#diff,       () => this.#onChangeDiffSelection()]
    ];

    for (const [select, handler] of handlers) {
      select.addEventListener('sl-change', async () => {
        if (this.#isUpdatingProgrammatically) return;
        if (this.#isInStateUpdateCycle) return;
        await handler();
      });

      select.addEventListener('sl-show', () => {
        this.#openDropdownCount++;
        select.closest('tool-bar')?.classList.add('dropdown-open');
      });

      select.addEventListener('sl-hide', () => {
        this.#openDropdownCount--;
        if (this.#openDropdownCount <= 0) {
          this.#openDropdownCount = 0;
          select.closest('tool-bar')?.classList.remove('dropdown-open');
        }
      });
    }
  }

  /**
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    this.#isInStateUpdateCycle = true;
    try {
      if (changedKeys.includes('collections') && state.collections) {
        await this.#populateCollectionSelectbox(state);
      }

      if (changedKeys.some(k => ['xml', 'pdf', 'diff', 'variant', 'fileData', 'collectionFilter'].includes(k)) && state.fileData) {
        const fileDataChanged = changedKeys.includes('fileData');
        const selectionsChanged = changedKeys.some(k => ['xml', 'pdf', 'diff', 'variant', 'collectionFilter'].includes(k));
        if (selectionsChanged || fileDataChanged) {
          await this.#populateSelectboxes(state);
        } else {
          this.#logger.debug("Not repopulating selectboxes.");
        }
      }

      this.#updateSelectboxValues(state);
    } finally {
      this.#isInStateUpdateCycle = false;
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
      await this.#populateSelectboxes(this.state);
      this.#updateSelectboxValues(this.state);
    }
  }

  /**
   * Reloads file data
   * @param {Object} [options]
   * @param {boolean} [options.refresh]
   */
  async reload(options = {}) {
    await this.getDependency('filedata').reload(options);
  }

  /**
   * Returns the current options for the given select element.
   * @param {'xml'|'pdf'|'diff'} type
   * @returns {{value: string, label: string}[]}
   */
  getOptionValues(type) {
    const select = { xml: this.#xml, pdf: this.#pdf, diff: this.#diff }[type]
    if (!select) return []
    return Array.from(select.querySelectorAll('sl-option')).map(opt => ({
      value: /** @type {any} */ (opt).value,
      label: opt.textContent?.trim() || ''
    }))
  }

  //
  // Private methods
  //

  /**
   * @param {string} label
   * @param {boolean} [isLocked]
   * @param {string} [variantId]
   * @returns {string}
   */
  #createDocumentLabel(label, isLocked, variantId) {
    const displayLabel = variantId ? `${label} [${variantId}]` : label;
    return isLocked === true
      ? `${displayLabel}<sl-icon name="file-lock2" slot="suffix"></sl-icon>`
      : displayLabel;
  }

  /** @param {ApplicationState} state */
  #updateSelectboxValues(state) {
    this.#isUpdatingProgrammatically = true;
    try {
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
      this.#diff.value = state.diff || "";
      this.#collection.value = state.collectionFilter || "";
    } finally {
      this.#isUpdatingProgrammatically = false;
    }
  }

  /** @param {boolean} isLoading */
  #setSelectboxLoadingState(isLoading) {
    const selectboxes = [
      this.#pdf, this.#xml, this.#diff,
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

    const sortedCollections = [...state.collections].sort((a, b) => a.name.localeCompare(b.name));
    for (const collection of sortedCollections) {
      const option = new SlOption();
      option.value = collection.id;
      option.textContent = collection.name;
      // @ts-ignore
      option.size = "small";
      this.#collection.appendChild(option);
    }

    this.#isUpdatingProgrammatically = true;
    try {
      this.#collection.value = state.collectionFilter || "";
    } finally {
      this.#isUpdatingProgrammatically = false;
    }
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

    this.#isUpdatingProgrammatically = true;
    try {
      this.#variant.value = state.variant || "";
    } finally {
      this.#isUpdatingProgrammatically = false;
    }
  }

  /** @param {ApplicationState} state */
  async #populateSelectboxes(state) {
    if (this.#isFileLoading) {
      this.#logger.debug("Ignoring populateSelectboxes request - file loading in progress");
      return;
    }
    if (this.#isPopulatingSelectboxes) {
      this.#logger.debug("Ignoring populateSelectboxes request - already in progress");
      return;
    }
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");

    this.#isPopulatingSelectboxes = true;
    this.#logger.debug("Populating selectboxes");
    this.#setSelectboxLoadingState(true);

    try {
      await this.#populateVariantSelectbox(state);

      for (const select of [this.#pdf, this.#xml, this.#diff]) {
        select.innerHTML = "";
      }

      if (state.fileData.length === 0) {
        this.#logger.debug("No files to display, selectboxes cleared");
        return;
      }

      const fileData = JSON.parse(JSON.stringify(state.fileData));
      let filteredFileData = fileData;
      const collectionFilter = state.collectionFilter;

      if (collectionFilter && collectionFilter !== "") {
        filteredFileData = fileData.filter(file =>
          file.collections && file.collections.includes(collectionFilter)
        ).map(file => { file.collections = [collectionFilter]; return file; });
      }

      const variant = state.variant;
      if (variant === "none") {
        filteredFileData = filteredFileData.filter(file => {
          const hasArtifactVariant = file.artifacts && file.artifacts.some(a => !!a.variant);
          return !hasArtifactVariant;
        });
      } else if (variant && variant !== "") {
        filteredFileData = filteredFileData.filter(file =>
          file.artifacts && file.artifacts.some(a => a.variant === variant)
        );
      }

      const grouped_files = groupFilesByCollection(filteredFileData);
      this.#collections = Object.keys(grouped_files).sort((a, b) => {
        if (a === "__unfiled") return -1;
        if (b === "__unfiled") return 1;
        return a.localeCompare(b);
      });
      this.#pdf.dataset.collections = JSON.stringify(this.#collections);

      let hasPopulatedVersionsForSelectedFile = false;

      for (const collection_name of this.#collections) {
        const displayName = getCollectionName(collection_name, state.collections);
        await createHtmlElements(`<small>${displayName}</small>`, this.#pdf);

        const files = grouped_files[collection_name].sort((a, b) => {
          const aLabel = a.source?.label || a.doc_metadata?.title || a.doc_id;
          const bLabel = b.source?.label || b.doc_metadata?.title || b.doc_id;
          return (aLabel < bLabel) ? -1 : (aLabel > bLabel) ? 1 : 0;
        });

        for (const file of files) {
          let fileIdentifier, displayLabel;

          if (file.source) {
            fileIdentifier = file.source.id;
            displayLabel = file.source.label;
          } else if (file.artifacts && file.artifacts.length > 0) {
            fileIdentifier = file.artifacts[0].id;
            displayLabel = `📄 ${file.doc_metadata?.title || file.doc_id}`;
          } else {
            continue;
          }

          const option = Object.assign(new SlOption, {
            value: fileIdentifier,
            textContent: displayLabel,
            size: "small",
          });
          option.dataset.doc_id = file.doc_id;
          option.dataset.collections = JSON.stringify(file.collections);
          this.#pdf.hoist = true;
          this.#pdf.appendChild(option);

          const isSelectedFile = (fileIdentifier === state.pdf) ||
            (file.source && file.source.file_type !== 'pdf' && fileIdentifier === state.xml);

          if (isSelectedFile && !hasPopulatedVersionsForSelectedFile) {
            hasPopulatedVersionsForSelectedFile = true;

            if (file.artifacts) {
              let artifactsToShow = file.artifacts;
              if (variant === "none") {
                artifactsToShow = file.artifacts.filter(a => !a.variant);
              } else if (variant && variant !== "") {
                artifactsToShow = file.artifacts.filter(a => a.variant === variant);
              }

              const goldToShow = artifactsToShow.filter(a => a.is_gold_standard);
              const versionsToShow = artifactsToShow.filter(a => !a.is_gold_standard);

              if (goldToShow.length > 0) {
                await createHtmlElements(`<small>Gold</small>`, this.#xml);
                await createHtmlElements(`<small>Gold</small>`, this.#diff);

                goldToShow.forEach(gold => {
                  const variantSuffix = (!variant || variant === "") ? gold.variant : undefined;
                  let opt = new SlOption();
                  // @ts-ignore
                  opt.size = "small";
                  opt.value = gold.id;
                  opt.innerHTML = this.#createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
                  this.#xml.appendChild(opt);
                  opt = new SlOption();
                  // @ts-ignore
                  opt.size = "small";
                  opt.value = gold.id;
                  opt.innerHTML = this.#createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
                  this.#diff.appendChild(opt);
                });

                if (versionsToShow.length > 0) {
                  this.#xml.appendChild(new SlDivider());
                  this.#diff.appendChild(new SlDivider());
                }
              }

              if (versionsToShow.length > 0) {
                await createHtmlElements(`<small>Versions</small>`, this.#xml);
                await createHtmlElements(`<small>Versions</small>`, this.#diff);

                versionsToShow.sort((a, b) => (a.version || 0) - (b.version || 0));

                versionsToShow.forEach(version => {
                  const variantSuffix = (!variant || variant === "") ? version.variant : undefined;
                  let opt = new SlOption();
                  // @ts-ignore
                  opt.size = "small";
                  opt.value = version.id;
                  opt.innerHTML = this.#createDocumentLabel(version.label, version.is_locked, variantSuffix);
                  this.#xml.appendChild(opt);
                  opt = new SlOption();
                  // @ts-ignore
                  opt.size = "small";
                  opt.value = version.id;
                  opt.innerHTML = this.#createDocumentLabel(version.label, version.is_locked, variantSuffix);
                  this.#diff.appendChild(opt);
                });
              }
            }
          }
        }
        this.#pdf.appendChild(new SlDivider());
      }
    } finally {
      this.#isPopulatingSelectboxes = false;
      this.#setSelectboxLoadingState(false);
    }
  }

  async #onChangePdfSelection() {
    const state = this.state;
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");

    const selectedIdentifier = this.#pdf.value;
    const selectedFile = state.fileData.find(file => {
      if (file.source && file.source.id === selectedIdentifier) return true;
      if (file.artifacts && file.artifacts.some(a => a.id === selectedIdentifier)) return true;
      return false;
    });

    if (!selectedFile) return;

    const collection = selectedFile.collections[0];
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
        await this.getDependency('services').removeMergeView();
        const stateUpdate = { collection };
        if (pdf) {
          stateUpdate.pdf = pdf;
        } else {
          stateUpdate.pdf = null;
        }
        await this.dispatchStateChange(stateUpdate);
        await this.getDependency('services').load(filesToLoad);
      } catch (error) {
        this.#logger.error(String(error));
        await this.dispatchStateChange({ collection: null, pdf: null, xml: null });
        await this.reload({ refresh: true });
      }
    }
  }

  async #onChangeXmlSelection() {
    const state = this.state;
    if (!state.fileData) throw new Error("fileData hasn't been loaded yet");
    const xml = this.#xml.value;
    if (xml && typeof xml === "string" && xml !== state.xml) {
      try {
        for (const file of state.fileData) {
          if (file.artifacts && file.artifacts.some(a => a.id === xml)) {
            await this.dispatchStateChange({ collection: file.collections[0] });
            break;
          }
        }
        await this.getDependency('services').removeMergeView();
        await this.getDependency('services').load({ xml });
        await this.dispatchStateChange({ xml });
      } catch (error) {
        console.error(String(error));
        await this.reload({ refresh: true });
        await this.dispatchStateChange({ xml: null });
        this.#dialog.error(String(error));
      }
    }
  }

  async #onChangeDiffSelection() {
    const state = this.state;
    const diff = String(this.#diff.value);
    if (diff && typeof diff === "string" && diff !== this.#xml.value) {
      try {
        await this.getDependency('services').showMergeView(diff);
      } catch (error) {
        console.error(error);
      }
    } else {
      await this.getDependency('services').removeMergeView();
    }
    await this.dispatchStateChange({ diff });
  }

  async #onChangeVariantSelection() {
    const variant = String(this.#variant.value);
    await this.dispatchStateChange({ variant, xml: null });
  }

  async #onChangeCollectionSelection() {
    const state = this.state;
    const collectionFilter = String(this.#collection.value);
    const collection = collectionFilter || null;

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
      await this.getDependency('services').removeMergeView();
      await this.dispatchStateChange({ collectionFilter, collection, pdf: null, xml: null, diff: null });
    } else {
      await this.dispatchStateChange({ collectionFilter, collection });
    }
  }
}

export default FileSelectionPlugin;


/** @deprecated Use FileSelectionPlugin class directly */
export const plugin = FileSelectionPlugin;

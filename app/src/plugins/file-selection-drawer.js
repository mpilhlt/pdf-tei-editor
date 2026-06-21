/**
 * File selection drawer plugin - replacement for selectbox-based file selection
 * Uses a SlDrawer with SlTree for hierarchical file selection
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlTreeItem, SlCheckbox, SlDrawer } from '../ui.js'
 * @import { DocumentItem } from '../modules/file-data-utils.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { fileDrawerPart } from '../templates/file-selection-drawer.types.js'
 * @import { fileDrawerButtonPart } from '../templates/file-drawer-button.types.js'
 */

/**
 * @typedef {object} ExportFormatInfo
 * @property {string} id - Format identifier
 * @property {string} label - Display label for the format
 * @property {string} url - URL to the XSLT stylesheet
 */

import { SlOption } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import ep from '../extension-points.js'
import {
  extractVariants,
  filterFileDataByVariant,
  filterFileDataByLabel,
  groupFilesByCollection,
  findMatchingGold,
  findFileBySourceId,
  getCollectionName
} from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import Plugin from '../modules/plugin-base.js'
import { canDeleteCollection, isCollectionOwner } from '../modules/collection-utils.js'

// Register templates
await registerTemplate('file-selection-drawer', 'file-selection-drawer.html');
await registerTemplate('file-drawer-button', 'file-drawer-button.html');

class FileSelectionDrawerPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'file-selection-drawer',
      deps: ['logger', 'dialog', 'client', 'filedata', 'move-files']
    });
  }

  static extensionPoints = [ep.toolbar.contentItems];

  /**
   * Extension point handler for `ep.toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's toolbar contribution.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  [ep.toolbar.contentItems]() {
    return [{ element: this.#triggerUi, priority: 10, position: 'left' }]
  }

  get #logger() { return this.getDependency('logger') }
  get #dialog() { return this.getDependency('dialog') }
  get #client() { return this.getDependency('client') }
  get #moveFiles() { return this.getDependency('move-files') }

  /** @type {HTMLElement & fileDrawerButtonPart} */
  #triggerUi = /** @type {any} */ (null)
  /** @type {SlDrawer & fileDrawerPart} */
  #drawerUi = /** @type {any} */ (null)

  // Private state
  #currentLabelFilter = '';
  #needsTreeUpdate = false;
  #isInitializing = true;  // blocks sl-selection-change until install macrotask flush
  #isUpdatingTree = false;  // blocks sl-selection-change during programmatic tree updates
  #isUpdatingSelect = false;  // blocks sl-change on variantSelect during programmatic value sets
  /** @type {Set<string>} */
  #selectedCollections = new Set();
  /** @type {Set<string>} PDF stable_ids checked for batch move/copy */
  #selectedDocuments = new Set();
  /** @type {ExportFormatInfo[]} */
  #availableExportFormats = [];

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    const triggerButton = createSingleFromTemplate('file-drawer-button');
    this.#triggerUi = /** @type {HTMLElement & fileDrawerButtonPart} */ (/** @type {any} */ (this.createUi(triggerButton)));

    const drawer = createSingleFromTemplate('file-selection-drawer', document.body);
    this.#drawerUi = /** @type {SlDrawer & fileDrawerPart} */ (/** @type {any} */ (this.createUi(drawer)));

    this.#triggerUi.addEventListener('click', () => this.open());

    this.#drawerUi.closeDrawer.addEventListener('click', () => this.close());
    this.#drawerUi.addEventListener('sl-request-close', () => this.close());

    this.#drawerUi.variantSelect.addEventListener('sl-change', () => {
      if (this.#isUpdatingSelect) return;
      if (this.state) {
        this.#onVariantChange(this.state);
      } else {
        this.#logger.warn("Variant change ignored: no current state available");
      }
    });

    this.#drawerUi.labelFilter.addEventListener('sl-input', () => {
      if (this.state) {
        this.#onLabelFilterChange(this.state);
      } else {
        this.#logger.warn("Label filter change ignored: no current state available");
      }
    });

    this.#drawerUi.addEventListener('sl-selection-change', (event) => {
      if (this.#isInitializing || this.#isUpdatingTree) return;
      if (this.state) {
        this.#onFileTreeSelection(event, this.state);
      }
    });

    this.#drawerUi.selectAllContainer.selectAllCheckbox.addEventListener('sl-change', () => {
      this.#onSelectAllChange();
    });

    this.#drawerUi.selectAllContainer.expandProjectsCheckbox.addEventListener('sl-change', () => {
      this.#onExpandProjectsChange();
    });

    this.#drawerUi.exportDropdown.exportMenu.addEventListener('sl-select', async (event) => {
      if (!this.state) return;
      // @ts-ignore - detail.item exists on SlMenu sl-select events
      const item = event.detail.item;
      const name = item.getAttribute('name');
      if (name === 'exportDefault') {
        await this.#handleExport(this.state, { includeVersions: false, teiOnly: false });
      } else if (name === 'exportWithVersions') {
        await this.#handleExport(this.state, { includeVersions: true, teiOnly: false });
      } else if (name === 'exportTeiOnly') {
        await this.#handleExport(this.state, { includeVersions: false, teiOnly: true });
      } else if (name === 'exportTeiAllVersions') {
        await this.#handleExport(this.state, { includeVersions: true, teiOnly: true });
      }
    });

    this.#drawerUi.deleteButton.addEventListener('click', async () => {
      if (this.state) {
        await this.#handleDelete(this.state);
      }
    });

    this.#drawerUi.importButton.addEventListener('click', () => {
      this.#drawerUi.importFileInput.click();
    });

    this.#drawerUi.importFileInput.addEventListener('change', async () => {
      if (this.state) {
        await this.#handleImport(this.state);
      }
    });

    this.#drawerUi.newCollectionButton.addEventListener('click', async () => {
      this.#logger.debug("New collection button clicked");
      if (this.state) {
        await this.#handleNewCollection(this.state);
      } else {
        this.#logger.warn("New collection button clicked but no current state available");
      }
    });

    this.#drawerUi.moveCopyButton.addEventListener('click', async () => {
      if (this.state) {
        await this.#handleMoveCopy(this.state);
      }
    });

    // Clear initializing flag after microtasks from component initialization have flushed
    setTimeout(() => { this.#isInitializing = false; }, 0);
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    const state = this.state;
    if (!state) return;

    if (['xml', 'pdf', 'variant', 'fileData', 'collections'].some(k => changedKeys.includes(k)) && state.fileData) {
      await this.#populateVariantSelect(state);

      const drawer = this.#drawerUi;
      if (drawer && drawer.open) {
        await this.#populateFileTree(state);
      } else {
        this.#needsTreeUpdate = true;
      }
    }

    if (this.#drawerUi?.variantSelect) {
      this.#isUpdatingSelect = true;
      try {
        this.#drawerUi.variantSelect.value = state.variant || "";
      } finally {
        setTimeout(() => { this.#isUpdatingSelect = false; }, 0);
      }
    }

    this.#updateButtonVisibility(state);
  }

  /**
   * Opens the file selection drawer
   */
  async open() {
    this.#logger.debug("Opening file selection drawer");
    this.#drawerUi?.show();

    await this.#fetchExportFormats();
    this.#populateExportFormats();

    if (this.#needsTreeUpdate && this.state?.fileData) {
      await this.#populateFileTree(this.state);
      this.#needsTreeUpdate = false;
    }
  }

  /**
   * Closes the file selection drawer
   */
  close() {
    this.#logger.debug("Closing file selection drawer");
    this.#selectedCollections.clear();
    this.#updateExportButtonState();
    this.#drawerUi.hide();
  }

  //
  // Private methods
  //

  /**
   * Fetches available export formats from plugins
   */
  async #fetchExportFormats() {
    try {
      const results = await this.context.invokePluginEndpoint('export_formats', [], { throws: false, result: 'full' });
      const allFormats = [];
      for (const result of results) {
        if (result && Array.isArray(result)) {
          allFormats.push(...result);
        } else {
          allFormats.push(result);
        }
      }
      this.#availableExportFormats = allFormats;
      this.#logger.debug(`Fetched ${this.#availableExportFormats.length} export formats`);
    } catch (error) {
      this.#logger.warn(`Failed to fetch export formats: ${error}`);
      this.#availableExportFormats = [];
    }
  }

  /**
   * Populates the export format checkboxes in the export menu
   */
  #populateExportFormats() {
    const container = this.#drawerUi.exportDropdown.exportMenu.exportFormatCheckboxes;
    const divider = this.#drawerUi.exportDropdown.exportMenu.exportFormatsDivider;

    if (!container) return;

    const title = container.querySelector('div');
    container.innerHTML = '';
    if (title) {
      container.appendChild(title);
    }

    if (this.#availableExportFormats.length === 0) {
      container.style.display = 'none';
      if (divider) divider.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    if (divider) divider.style.display = 'block';

    this.#availableExportFormats.forEach(format => {
      const div = document.createElement('div');
      div.innerHTML = `<sl-checkbox size="small" value="${format.id}">${format.label}</sl-checkbox>`;
      container.appendChild(div);
      div.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });
  }

  /**
   * Gets the checked export formats with their URLs
   * @returns {Array<{id: string, url: string}>}
   */
  #getCheckedExportFormats() {
    const container = this.#drawerUi.exportDropdown.exportMenu.exportFormatCheckboxes;
    if (!container) return [];

    const checked = container.querySelectorAll('sl-checkbox[checked]');
    /** @type {ExportFormatInfo[]} */
    const results = [];

    checked.forEach(checkbox => {
      const formatId = /** @type {HTMLInputElement} */ (checkbox).value;
      const format = this.#availableExportFormats.find(f => f.id === formatId);
      if (format) {
        results.push(format);
      }
    });

    return results;
  }

  /**
   * Updates the visibility of import/export/delete/new buttons based on user role
   * @param {ApplicationState} state
   */
  #updateButtonVisibility(state) {
    const user = state.user;
    const hasReviewerRole = user && user.roles && (
      user.roles.includes('*') ||
      user.roles.includes('admin') ||
      user.roles.includes('reviewer')
    );
    const ownsAnyCollection = (state.collections || []).some(col => isCollectionOwner(user, col));

    const importButton = this.#drawerUi.importButton;
    const exportDropdown = this.#drawerUi.exportDropdown;
    const deleteButton = this.#drawerUi.deleteButton;
    const newCollectionButton = this.#drawerUi.newCollectionButton;

    const moveCopyButton = this.#drawerUi.moveCopyButton;
    if (hasReviewerRole) {
      importButton.style.display = '';
      exportDropdown.style.display = '';
      newCollectionButton.style.display = '';
      moveCopyButton.style.display = '';
    } else {
      importButton.style.display = 'none';
      exportDropdown.style.display = 'none';
      newCollectionButton.style.display = 'none';
      moveCopyButton.style.display = 'none';
    }
    const isAdmin = user && user.roles && (user.roles.includes('*') || user.roles.includes('admin'));
    deleteButton.style.display = isAdmin || ownsAnyCollection ? '' : 'none';
  }

  /**
   * Populates the variant selectbox with unique variants from fileData
   * @param {ApplicationState} state
   */
  async #populateVariantSelect(state) {
    if (!state.fileData) return;

    const variantSelect = this.#drawerUi?.variantSelect;
    if (!variantSelect) return;

    variantSelect.innerHTML = "";

    const variants = extractVariants(state.fileData);

    const allOption = new SlOption();
    allOption.value = "";
    allOption.textContent = "All";
    // @ts-ignore - size property not in SlOption type definition
    allOption.size = "small";
    variantSelect.appendChild(allOption);

    const noneOption = new SlOption();
    noneOption.value = "none";
    noneOption.textContent = "None";
    // @ts-ignore - size property not in SlOption type definition
    noneOption.size = "small";
    variantSelect.appendChild(noneOption);

    [...variants].sort().forEach(variant => {
      const option = new SlOption();
      option.value = variant;
      option.textContent = variant;
      // @ts-ignore - size property not in SlOption type definition
      option.size = "small";
      variantSelect.appendChild(option);
    });

    this.#isUpdatingSelect = true;
    try {
      variantSelect.value = state.variant || "";
    } finally {
      setTimeout(() => { this.#isUpdatingSelect = false; }, 0);
    }
  }

  /**
   * Build a complete sl-tree-item for a collection, including all file children.
   * @param {string} collectionName
   * @param {ApplicationState} state
   * @param {Object} groupedFiles
   * @param {function(string): boolean} shouldExpandCollection
   * @param {function(Object): boolean} shouldExpandPdf
   * @returns {HTMLElement}
   */
  #buildCollectionTreeItem(collectionName, state, groupedFiles, shouldExpandCollection, shouldExpandPdf) {
    const collectionDisplayName = getCollectionName(collectionName, state.collections || []);
    const collectionItem = document.createElement('sl-tree-item');
    collectionItem.expanded = shouldExpandCollection(collectionName);
    collectionItem.className = 'collection-item';
    collectionItem.dataset.collection = collectionName;

    const checkbox = document.createElement('sl-checkbox');
    checkbox.size = 'small';
    checkbox.checked = this.#selectedCollections.has(collectionName);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('sl-change', (e) => {
      e.stopPropagation();
      this.#onCollectionCheckboxChange(collectionName, checkbox.checked);
    });

    const label = document.createElement('span');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.5rem';
    label.innerHTML = `<sl-icon name="folder"></sl-icon><span>${collectionDisplayName}</span>`;

    collectionItem.innerHTML = '';
    collectionItem.appendChild(checkbox);
    collectionItem.appendChild(label);

    const files = (groupedFiles[collectionName] || []).sort((a, b) => {
      const aLabel = a.source?.label || a.doc_metadata?.title || a.doc_id;
      const bLabel = b.source?.label || b.doc_metadata?.title || b.doc_id;
      return (aLabel < bLabel) ? -1 : (aLabel > bLabel) ? 1 : 0;
    });

    for (const file of files) {
      let artifactsToShow = file.artifacts || [];
      if (state.variant === "none") {
        artifactsToShow = artifactsToShow.filter(a => !a.variant);
      } else if (state.variant && state.variant !== "") {
        artifactsToShow = artifactsToShow.filter(a => a.variant === state.variant);
      }
      const goldToShow = artifactsToShow.filter(a => a.is_gold_standard);
      const versionsToShow = artifactsToShow.filter(a => !a.is_gold_standard);

      const pdfItem = document.createElement('sl-tree-item');
      pdfItem.expanded = shouldExpandPdf(file);
      pdfItem.className = 'pdf-item';
      pdfItem.dataset.type = file.source?.file_type === 'pdf' ? 'pdf' : 'xml-only';
      pdfItem.dataset.hash = file.source?.id || '';
      pdfItem.dataset.collection = file.collections[0];
      const displayLabel = file.source?.label || file.doc_metadata?.title || file.doc_id;
      const icon = file.source?.file_type === 'pdf' ? 'file-pdf' : 'file-earmark-code';
      const pdfId = file.source?.id || '';

      const docCheckbox = /** @type {SlCheckbox} */ (document.createElement('sl-checkbox'));
      docCheckbox.size = 'small';
      docCheckbox.checked = this.#selectedDocuments.has(pdfId);
      docCheckbox.addEventListener('click', e => e.stopPropagation());
      docCheckbox.addEventListener('sl-change', e => {
        e.stopPropagation();
        this.#onDocumentCheckboxChange(pdfId, docCheckbox.checked, collectionName);
      });
      const iconEl = document.createElement('sl-icon');
      iconEl.name = icon;
      const labelEl = document.createElement('span');
      labelEl.textContent = displayLabel;
      pdfItem.appendChild(docCheckbox);
      pdfItem.appendChild(iconEl);
      pdfItem.appendChild(labelEl);

      if (goldToShow.length > 0) {
        const goldSection = document.createElement('sl-tree-item');
        goldSection.expanded = true;
        goldSection.className = 'gold-section';
        goldSection.dataset.type = 'section';
        goldSection.innerHTML = `<sl-icon name="award"></sl-icon><span>Gold</span>`;
        goldToShow.forEach(gold => {
          const variantSuffix = (!state.variant || state.variant === "") ? gold.variant ?? undefined : undefined;
          const goldItem = document.createElement('sl-tree-item');
          goldItem.className = 'gold-item';
          goldItem.dataset.type = 'gold';
          goldItem.dataset.hash = gold.id;
          goldItem.dataset.pdfHash = file.source?.id || '';
          goldItem.dataset.collection = file.collections[0];
          goldItem.innerHTML = createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
          goldSection.appendChild(goldItem);
        });
        pdfItem.appendChild(goldSection);
      }

      if (versionsToShow.length > 0) {
        const versionsSection = document.createElement('sl-tree-item');
        versionsSection.expanded = false;
        versionsSection.className = 'versions-section';
        versionsSection.dataset.type = 'section';
        versionsSection.innerHTML = `<sl-icon name="file-earmark-diff"></sl-icon><span>Versions</span>`;
        versionsToShow.forEach(version => {
          const variantSuffix = (!state.variant || state.variant === "") ? version.variant ?? undefined : undefined;
          const versionItem = document.createElement('sl-tree-item');
          versionItem.className = 'version-item';
          versionItem.dataset.type = 'version';
          versionItem.dataset.hash = version.id;
          versionItem.dataset.pdfHash = file.source?.id || '';
          versionItem.dataset.collection = file.collections[0];
          versionItem.innerHTML = createDocumentLabel(version.label, version.is_locked, variantSuffix);
          versionsSection.appendChild(versionItem);
        });
        pdfItem.appendChild(versionsSection);
      }
      collectionItem.appendChild(pdfItem);
    }
    return collectionItem;
  }

  /**
   * Populates the file tree with hierarchical structure
   * @param {ApplicationState} state
   */
  async #populateFileTree(state) {
    if (!state.fileData) return;
    this.#selectedDocuments.clear();
    this.#updateMoveCopyButtonState();

    const fileTree = this.#drawerUi?.fileTree;
    if (!fileTree) return;

    let filteredData = filterFileDataByVariant(state.fileData, state.variant);
    filteredData = filterFileDataByLabel(filteredData, this.#currentLabelFilter);

    const groupedFiles = groupFilesByCollection(filteredData);

    fileTree.innerHTML = '';

    /** @type { (collection:string) => boolean} */
    const shouldExpandCollection = (collectionName) => {
      if (!state.pdf && !state.xml) return false;
      const files = groupedFiles[collectionName];
      if (!files) return false;
      return files.some(file => {
        if (state.pdf && file.source?.id === state.pdf) return true;
        if (state.xml) {
          return file.artifacts?.some(artifact => artifact.id === state.xml);
        }
        return false;
      });
    };

    /** @type { (file:DocumentItem) => boolean} */
    const shouldExpandPdf = (file) => {
      if (!state.pdf && !state.xml) return false;
      if (state.pdf && file.source?.id === state.pdf) return true;
      if (state.xml) {
        return file.artifacts?.some(artifact => artifact.id === state.xml);
      }
      return false;
    };

    const projects = state.projects || [];
    const collectionsWithFiles = new Set(Object.keys(groupedFiles));
    const allVisibleCollections = new Set([
      ...collectionsWithFiles,
      ...(state.collections || []).map(c => c.id)
    ]);
    const renderedCollections = new Set();

    const selectAllContainer = this.#drawerUi.selectAllContainer;
    selectAllContainer.style.display = allVisibleCollections.size > 0 ? 'flex' : 'none';

    for (const project of projects) {
      const projectCollections = (project.collections || []).filter(colId => allVisibleCollections.has(colId));
      if (projectCollections.length === 0) continue;

      const projectItem = document.createElement('sl-tree-item');
      projectItem.expanded = this.#getProjectExpanded(`project:${project.id}`);
      projectItem.className = 'project-item';
      projectItem.dataset.projectKey = `project:${project.id}`;
      projectItem.addEventListener('sl-expand', () => {
        this.#setProjectExpanded(`project:${project.id}`, true);
        this.#syncExpandProjectsCheckbox();
      });
      projectItem.addEventListener('sl-collapse', () => {
        this.#setProjectExpanded(`project:${project.id}`, false);
        this.#syncExpandProjectsCheckbox();
      });
      const projectLabel = document.createElement('span');
      projectLabel.style.display = 'flex';
      projectLabel.style.alignItems = 'center';
      projectLabel.style.gap = '0.5rem';
      projectLabel.innerHTML = `<sl-icon name="folder2-open"></sl-icon><strong>${project.name}</strong>`;
      projectItem.appendChild(projectLabel);

      for (const colId of projectCollections) {
        renderedCollections.add(colId);
        projectItem.appendChild(this.#buildCollectionTreeItem(colId, state, groupedFiles, shouldExpandCollection, shouldExpandPdf));
      }
      fileTree.appendChild(projectItem);
    }

    const orphanColIds = [...allVisibleCollections].filter(colId => !renderedCollections.has(colId));
    if (orphanColIds.length > 0) {
      const noProjectItem = document.createElement('sl-tree-item');
      noProjectItem.expanded = this.#getProjectExpanded('no-project');
      noProjectItem.className = 'project-item';
      noProjectItem.dataset.projectKey = 'no-project';
      noProjectItem.addEventListener('sl-expand', () => {
        this.#setProjectExpanded('no-project', true);
        this.#syncExpandProjectsCheckbox();
      });
      noProjectItem.addEventListener('sl-collapse', () => {
        this.#setProjectExpanded('no-project', false);
        this.#syncExpandProjectsCheckbox();
      });
      const noProjectLabel = document.createElement('span');
      noProjectLabel.style.display = 'flex';
      noProjectLabel.style.alignItems = 'center';
      noProjectLabel.style.gap = '0.5rem';
      noProjectLabel.innerHTML = `<sl-icon name="folder2-open"></sl-icon><strong>No project</strong>`;
      noProjectItem.appendChild(noProjectLabel);

      for (const colId of orphanColIds) {
        noProjectItem.appendChild(this.#buildCollectionTreeItem(colId, state, groupedFiles, shouldExpandCollection, shouldExpandPdf));
      }
      fileTree.appendChild(noProjectItem);
    }

    this.#isUpdatingTree = true;
    try {
      await this.#selectCurrentStateItem(state, fileTree);
    } finally {
      setTimeout(() => { this.#isUpdatingTree = false; }, 0);
    }

    this.#updateExportButtonState();
    this.#syncExpandProjectsCheckbox();
  }

  /**
   * Selects the tree item that corresponds to the current state
   * @param {ApplicationState} state
   * @param {HTMLElement} fileTree
   */
  async #selectCurrentStateItem(state, fileTree) {
    if (!state.pdf && !state.xml) return;

    let itemToSelect = null;

    if (state.xml) {
      itemToSelect = fileTree.querySelector(`[data-type="gold"][data-hash="${state.xml}"], [data-type="version"][data-hash="${state.xml}"], [data-type="xml-only"][data-hash="${state.xml}"]`);
    } else if (state.pdf) {
      itemToSelect = fileTree.querySelector(`[data-type="pdf"][data-hash="${state.pdf}"]`);
    }

    if (itemToSelect) {
      const currentSelection = /** @type {NodeListOf<SlTreeItem>} */ (fileTree.querySelectorAll('sl-tree-item[selected]'));
      currentSelection.forEach(item => { item.selected = false; });
      /** @type {SlTreeItem} */ (itemToSelect).selected = true;
    }
  }

  //
  // Event handlers
  //

  /**
   * @param {ApplicationState} state
   */
  async #onVariantChange(state) {
    const variant = /** @type {string|null} */ (this.#drawerUi?.variantSelect?.value);
    await this.dispatchStateChange({ variant, xml: null });
  }

  /**
   * @param {ApplicationState} state
   */
  async #onLabelFilterChange(state) {
    this.#currentLabelFilter = this.#drawerUi?.labelFilter?.value || '';
    await this.#populateFileTree(state);
  }

  /**
   * @param {Event} event
   * @param {ApplicationState} state
   */
  async #onFileTreeSelection(event, state) {
    // @ts-ignore - detail property exists on custom events
    const selectedItems = event.detail.selection;
    if (selectedItems.length === 0) return;
    if (!state.fileData) {
      throw new Error("No file data in state")
    }

    const selectedItem = selectedItems[0];
    const type = selectedItem.dataset.type;
    const hash = selectedItem.dataset.hash;
    const pdfHash = selectedItem.dataset.pdfHash;
    const collection = selectedItem.dataset.collection;

    if (type === 'section') return;

    const _owningProject = collection
      ? (state.projects || []).find(p => p.collections && p.collections.includes(collection))
      : null;

    const stateUpdates = {};

    if (type === 'pdf') {
      stateUpdates.pdf = hash;
      stateUpdates.collection = collection;
      stateUpdates.project = _owningProject ? _owningProject.id : null;

      const selectedFile = findFileBySourceId(state.fileData, hash);
      if (selectedFile) {
        const matchingGold = findMatchingGold(selectedFile, state.variant);
        if (matchingGold) {
          stateUpdates.xml = matchingGold.id;
        } else {
          stateUpdates.xml = null;
        }
      }
    } else if (type === 'xml-only') {
      stateUpdates.xml = hash;
      stateUpdates.pdf = null;
      stateUpdates.collection = collection;
      stateUpdates.project = _owningProject ? _owningProject.id : null;
    } else if (type === 'gold' || type === 'version') {
      stateUpdates.xml = hash;
      stateUpdates.collection = collection;
      stateUpdates.project = _owningProject ? _owningProject.id : null;

      if (pdfHash && pdfHash !== state.pdf) {
        stateUpdates.pdf = pdfHash;
      }
    }

    this.close();

    await this.dispatchStateChange(stateUpdates);

    const filesToLoad = {};
    if (stateUpdates.pdf && stateUpdates.pdf !== state.pdf) {
      filesToLoad.pdf = stateUpdates.pdf;
    }
    if (stateUpdates.xml && stateUpdates.xml !== state.xml) {
      filesToLoad.xml = stateUpdates.xml;
    }

    if (Object.keys(filesToLoad).length > 0) {
      try {
        await this.getDependency('services').load(filesToLoad);
      } catch (error) {
        this.#logger.error("Error loading files:" + String(error));
        await this.dispatchStateChange({ collection: null, pdf: null, xml: null });
      }
    }
  }

  /**
   * @param {string} collectionName
   * @param {boolean} checked
   */
  #onCollectionCheckboxChange(collectionName, checked) {
    if (checked) {
      this.#selectedCollections.add(collectionName);
    } else {
      this.#selectedCollections.delete(collectionName);
    }

    // Sync document checkboxes — programmatic, does NOT fire sl-change
    const collectionTreeItem = /** @type {HTMLElement|null} */ (
      this.#drawerUi.fileTree.querySelector(`.collection-item[data-collection="${collectionName}"]`)
    );
    if (collectionTreeItem) {
      const pdfItems = collectionTreeItem.querySelectorAll('.pdf-item');
      pdfItems.forEach(item => {
        const pdfCheckbox = /** @type {SlCheckbox} */ (item.querySelector('sl-checkbox'));
        const pdfId = /** @type {HTMLElement} */ (item).dataset.hash;
        if (pdfCheckbox && pdfId) {
          pdfCheckbox.checked = checked;
          if (checked) {
            this.#selectedDocuments.add(pdfId);
          } else {
            this.#selectedDocuments.delete(pdfId);
          }
        }
      });
    }

    this.#updateExportButtonState();
    this.#updateMoveCopyButtonState();
  }

  /**
   * @param {string} pdfId
   * @param {boolean} checked
   * @param {string} collectionName
   */
  #onDocumentCheckboxChange(pdfId, checked, collectionName) {
    if (checked) {
      this.#selectedDocuments.add(pdfId);
    } else {
      this.#selectedDocuments.delete(pdfId);
    }

    // Update collection checkbox state (checked / indeterminate / unchecked)
    const collectionTreeItem = /** @type {HTMLElement|null} */ (
      this.#drawerUi.fileTree.querySelector(`.collection-item[data-collection="${collectionName}"]`)
    );
    if (collectionTreeItem) {
      const pdfCheckboxes = /** @type {SlCheckbox[]} */ (
        [...collectionTreeItem.querySelectorAll('.pdf-item sl-checkbox')]
      );
      const checkedCount = pdfCheckboxes.filter(cb => cb.checked).length;
      const collectionCheckbox = /** @type {SlCheckbox} */ (
        collectionTreeItem.querySelector('sl-checkbox')
      );
      if (collectionCheckbox) {
        if (checkedCount === 0) {
          collectionCheckbox.indeterminate = false;
          collectionCheckbox.checked = false;
        } else if (checkedCount === pdfCheckboxes.length) {
          collectionCheckbox.indeterminate = false;
          collectionCheckbox.checked = true;
        } else {
          collectionCheckbox.indeterminate = true;
        }
      }
    }

    this.#updateMoveCopyButtonState();
  }

  #onSelectAllChange() {
    const selectAllCheckbox = this.#drawerUi.selectAllContainer.selectAllCheckbox;
    const fileTree = this.#drawerUi.fileTree;
    const checked = selectAllCheckbox.checked;

    const collectionItems = fileTree.querySelectorAll('.collection-item');

    collectionItems.forEach(item => {
      const checkbox = /** @type {SlCheckbox} */ (item.querySelector('sl-checkbox'));
      const collectionName = /** @type {HTMLElement} */ (item).dataset.collection;
      if (checkbox && collectionName) {
        checkbox.checked = checked;
        if (checked) {
          this.#selectedCollections.add(collectionName);
        } else {
          this.#selectedCollections.delete(collectionName);
        }
      }
    });

    this.#updateExportButtonState();
  }

  // TODO #368: Replace sessionStorage with a generic UI state persistence mechanism
  static #STORAGE_KEY_PREFIX = 'file-drawer-expanded:';

  /**
   * @param {string} key
   * @param {boolean} [defaultValue]
   */
  #getProjectExpanded(key, defaultValue = true) {
    const stored = sessionStorage.getItem(FileSelectionDrawerPlugin.#STORAGE_KEY_PREFIX + key);
    return stored !== null ? stored === 'true' : defaultValue;
  }

  /**
   * @param {string} key
   * @param {boolean} expanded
   */
  #setProjectExpanded(key, expanded) {
    sessionStorage.setItem(FileSelectionDrawerPlugin.#STORAGE_KEY_PREFIX + key, String(expanded));
  }

  #onExpandProjectsChange() {
    const checkbox = this.#drawerUi.selectAllContainer.expandProjectsCheckbox;
    const expand = checkbox.checked;
    const projectItems = this.#drawerUi.fileTree.querySelectorAll('.project-item');
    projectItems.forEach(item => {
      const el = /** @type {HTMLElement & {expanded: boolean}} */ (item);
      el.expanded = expand;
      const key = /** @type {HTMLElement} */ (item).dataset.projectKey;
      if (key) this.#setProjectExpanded(key, expand);
    });
    this.#syncExpandProjectsCheckbox();
  }

  #syncExpandProjectsCheckbox() {
    const checkbox = this.#drawerUi?.selectAllContainer?.expandProjectsCheckbox;
    if (!checkbox) return;
    const projectItems = [...this.#drawerUi.fileTree.querySelectorAll('.project-item')];
    if (projectItems.length === 0) {
      checkbox.indeterminate = false;
      checkbox.checked = true;
      return;
    }
    const expandedCount = projectItems.filter(item => /** @type {any} */ (item).expanded).length;
    if (expandedCount === projectItems.length) {
      checkbox.indeterminate = false;
      checkbox.checked = true;
    } else if (expandedCount === 0) {
      checkbox.indeterminate = false;
      checkbox.checked = false;
    } else {
      checkbox.indeterminate = true;
    }
  }

  #updateMoveCopyButtonState() {
    const moveCopyButton = this.#drawerUi.moveCopyButton;
    moveCopyButton.disabled = this.#selectedDocuments.size === 0;
  }

  #updateExportButtonState() {
    const exportButton = this.#drawerUi.exportDropdown.exportButton;
    const deleteButton = this.#drawerUi.deleteButton;
    const hasSelection = this.#selectedCollections.size > 0;
    exportButton.disabled = !hasSelection;

    const currentState = this.state;
    const allSelectedDeletable = hasSelection && currentState !== null && [...this.#selectedCollections].every(id => {
      const col = (currentState.collections || []).find(c => c.id === id);
      return col && canDeleteCollection(currentState.user, col);
    });
    deleteButton.disabled = !allSelectedDeletable;
  }

  /**
   * @param {ApplicationState} state
   * @param {{includeVersions?: boolean, teiOnly?: boolean}} options
   */
  async #handleExport(state, { includeVersions = false, teiOnly = false } = {}) {
    if (this.#selectedCollections.size === 0) return;
    if (!state.sessionId) {
      this.#logger.error("Cannot export: no session ID available");
      return;
    }

    const collections = Array.from(this.#selectedCollections).join(',');

    const params = new URLSearchParams({
      sessionId: state.sessionId,
      collections: collections
    });

    const variantSelect = this.#drawerUi.variantSelect;
    const selectedVariant = /** @type {string} */ (variantSelect.value);
    if (selectedVariant && selectedVariant !== '') {
      params.append('variants', selectedVariant);
    }

    if (includeVersions) params.append('include_versions', 'true');
    if (teiOnly) params.append('tei_only', 'true');

    const checkedFormats = this.#getCheckedExportFormats();
    if (checkedFormats.length > 0) {
      params.append('additional_formats', JSON.stringify(checkedFormats));
      this.#logger.debug(`Additional export formats: ${checkedFormats.map(f => f.id).join(', ')}`);
    }

    this.#logger.debug(`Exporting collections: ${collections}${selectedVariant ? ` (variant: ${selectedVariant})` : ''}${includeVersions ? ' (with versions)' : ''}${teiOnly ? ' (TEI only)' : ''}`);

    const exportButton = this.#drawerUi.exportDropdown.exportButton;
    exportButton.disabled = true;
    exportButton.loading = true;

    try {
      const statsUrl = `/api/v1/export?${params.toString()}`;
      const statsResponse = await fetch(statsUrl);

      if (!statsResponse.ok) {
        let errorMessage = `Export failed: ${statsResponse.statusText}`;
        try {
          const errorData = await statsResponse.json();
          if (errorData.detail) errorMessage = errorData.detail;
        } catch { /* ignore */ }
        throw new Error(errorMessage);
      }

      const stats = await statsResponse.json();

      if (!stats.files_exported || stats.files_exported <= 0) {
        notify("No files to export. The selected collections may be empty or contain no matching files.", "warning", "exclamation-triangle");
        return;
      }

      params.append('download', 'true');
      const downloadUrl = `/api/v1/export?${params.toString()}`;
      const downloadResponse = await fetch(downloadUrl);

      if (!downloadResponse.ok) {
        let errorMessage = `Download failed: ${downloadResponse.statusText}`;
        try {
          const errorData = await downloadResponse.json();
          if (errorData.detail) errorMessage = errorData.detail;
        } catch { /* ignore */ }
        throw new Error(errorMessage);
      }

      const blob = await downloadResponse.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'export.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);

      notify(`Exported ${stats.files_exported} files successfully`, "success", "check-circle");
      this.#logger.info(`Export completed: ${stats.files_exported} files exported`);
    } catch (error) {
      this.#logger.error("Export failed: " + String(error));
      notify(/** @type {Error} */ (error).message || "Export failed", "danger", "exclamation-octagon");
    } finally {
      exportButton.disabled = this.#selectedCollections.size === 0;
      exportButton.loading = false;
    }
  }

  /**
   * @param {ApplicationState} state
   */
  async #handleImport(state) {
    const fileInput = this.#drawerUi.importFileInput;
    const file = fileInput.files?.[0];

    if (!file) {
      this.#logger.debug("No file selected for import");
      return;
    }

    if (!state.sessionId) {
      this.#logger.error("Cannot import: no session ID available");
      notify("Cannot import: not authenticated", "danger", "exclamation-triangle");
      return;
    }

    this.#logger.info(`Importing file: ${file.name} (${file.size} bytes)`);

    const importButton = this.#drawerUi.importButton;
    importButton.disabled = true;
    importButton.loading = true;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const url = `/api/v1/import?sessionId=${encodeURIComponent(state.sessionId)}&recursive_collections=true`;
      const response = await fetch(url, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || `Import failed: ${response.statusText}`);
      }

      const stats = await response.json();

      this.#logger.info(
        `Import completed: ${stats.files_imported} imported, ` +
        `${stats.files_skipped} skipped, ${stats.errors?.length || 0} errors`
      );

      let message = `Imported ${stats.files_imported} files`;
      if (stats.files_skipped > 0) message += `, skipped ${stats.files_skipped}`;
      if (stats.errors && stats.errors.length > 0) {
        message += `, ${stats.errors.length} errors`;
        notify(message, "warning", "exclamation-triangle");
        stats.errors.forEach(/** @param {{ doc_id: string, error: string }} err */ err => {
          this.#logger.error(`Import error for ${err.doc_id}: ${err.error}`);
        });
      } else {
        notify(message, "success", "check-circle");
      }

      fileInput.value = '';
      this.close();
      await this.getDependency('filedata').reload({ refresh: true });

    } catch (error) {
      this.#logger.error("Import failed: " + String(error));
      notify(`Import failed: ${/** @type {Error} */ (error).message}`, "danger", "exclamation-octagon");
      fileInput.value = '';
    } finally {
      importButton.disabled = false;
      importButton.loading = false;
    }
  }

  /**
   * @param {ApplicationState} state
   */
  async #handleNewCollection(state) {
    this.#logger.debug("handleNewCollection called");

    const newCollectionId = await this.#dialog.prompt(
      "Enter new collection ID (Only letters, numbers, '-' and '_'):",
      "New Collection",
      "",
      "collection-id"
    );

    this.#logger.debug(`Collection ID from prompt: ${newCollectionId}`);

    if (!newCollectionId) {
      this.#logger.debug("Collection creation cancelled - no ID provided");
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
      this.#logger.warn(`Invalid collection ID: ${newCollectionId}`);
      notify("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.", "danger", "exclamation-triangle");
      return;
    }

    this.#logger.debug("Collection ID validated, showing name prompt");

    const newCollectionName = await this.#dialog.prompt(
      "Enter collection display name (optional, leave blank to use ID):",
      "Collection Name",
      newCollectionId
    );

    this.#logger.debug(`Collection name from prompt: ${newCollectionName}`);

    if (newCollectionName === null) {
      this.#logger.debug("Collection creation cancelled - name prompt cancelled");
      return;
    }

    this.#logger.debug("Proceeding with collection creation");

    if (!state.sessionId) {
      this.#logger.error("Cannot create collection: no session ID available");
      notify("Cannot create collection: not authenticated", "danger", "exclamation-triangle");
      return;
    }

    this.#logger.info(`Creating new collection: ${newCollectionId}`);

    const newCollectionButton = this.#drawerUi.newCollectionButton;
    newCollectionButton.disabled = true;
    newCollectionButton.loading = true;

    try {
      const result = await (/** @type {any} */ (this.#client)).createCollection(
        newCollectionId,
        newCollectionName || newCollectionId
      );

      if (result) {
        this.#logger.info(`Collection '${newCollectionId}' created successfully`);
        notify(`Collection '${newCollectionName || newCollectionId}' created successfully`, "success", "check-circle");
        await this.getDependency('filedata').reload({ refresh: true });
      }
    } catch (error) {
      this.#logger.error("Failed to create collection: " + String(error));
      notify(`Failed to create collection: ${/** @type {Error} */ (error).message || String(error)}`, "danger", "exclamation-octagon");
    } finally {
      newCollectionButton.disabled = false;
      newCollectionButton.loading = false;
    }
  }

  /**
   * @param {ApplicationState} state
   */
  async #handleMoveCopy(state) {
    const pdfIds = Array.from(this.#selectedDocuments);
    if (pdfIds.length === 0) return;

    const result = await this.#moveFiles.showBatchDialog({
      pdfIds,
      collections: state.collections || [],
      projects: state.projects || []
    });

    if (!result) return;

    const { action, targetCollections } = result;

    if (targetCollections.length === 0) {
      this.#dialog.error('No collection selected.');
      return;
    }

    const collectionNames = targetCollections
      .map(id => (state.collections || []).find(c => c.id === id)?.name || id)
      .join(', ');

    const confirmMsg = action === 'move'
      ? `Move ${pdfIds.length} document(s) to "${collectionNames}"?\n\nThis will remove them from their current collection(s).`
      : `Copy ${pdfIds.length} document(s) to "${collectionNames}"?`;

    if (!confirm(confirmMsg)) return;

    const moveCopyButton = this.#drawerUi.moveCopyButton;
    moveCopyButton.loading = true;
    moveCopyButton.disabled = true;

    let successCount = 0;
    const errors = [];

    for (const pdfId of pdfIds) {
      for (const collectionId of targetCollections) {
        try {
          if (action === 'move') {
            await this.#client.moveFiles(pdfId, collectionId);
          } else {
            await this.#client.copyFiles(pdfId, collectionId);
          }
          successCount++;
        } catch (error) {
          errors.push({ pdfId, collectionId, error: String(error) });
          this.#logger.error(`Failed to ${action} ${pdfId} to ${collectionId}: ${error}`);
        }
      }
    }

    moveCopyButton.loading = false;

    const verb = action === 'move' ? 'moved' : 'copied';
    if (errors.length === 0) {
      notify(`${successCount} document(s) ${verb} to "${collectionNames}"`, 'success', 'check-circle');
    } else if (successCount > 0) {
      notify(`${successCount} succeeded, ${errors.length} failed`, 'warning', 'exclamation-triangle');
    } else {
      notify(`Failed to ${action} all documents`, 'danger', 'exclamation-octagon');
    }

    this.#selectedDocuments.clear();
    await this.getDependency('filedata').reload({ refresh: true });
  }

  /**
   * @param {ApplicationState} state
   */
  async #handleDelete(state) {
    if (this.#selectedCollections.size === 0) {
      this.#logger.warn("Delete button clicked but no collections selected");
      return;
    }

    const collectionIds = Array.from(this.#selectedCollections);

    let confirmMessage;
    if (collectionIds.length === 1) {
      const collectionName = getCollectionName(collectionIds[0], state.collections || []);
      confirmMessage =
        `Do you really want to delete collection '${collectionName}' and its content?\n\n` +
        `This will remove the collection and mark all files that are only in this collection as deleted.`;
    } else {
      const collectionNames = collectionIds.map(id => getCollectionName(id, state.collections || [])).join(', ');
      confirmMessage =
        `Do you really want to delete ${collectionIds.length} collections (${collectionNames}) and their content?\n\n` +
        `This will remove the collections and mark all files that are only in these collections as deleted.`;
    }

    const confirmed = confirm(confirmMessage);

    if (!confirmed) {
      this.#logger.debug(`Collection deletion cancelled by user: ${collectionIds.join(', ')}`);
      return;
    }

    if (!state.sessionId) {
      this.#logger.error("Cannot delete collections: no session ID available");
      notify("Cannot delete collections: not authenticated", "danger", "exclamation-triangle");
      return;
    }

    this.#logger.info(`Deleting collections: ${collectionIds.join(', ')}`);

    const deleteButton = this.#drawerUi.deleteButton;
    deleteButton.disabled = true;
    deleteButton.loading = true;

    try {
      let totalFilesUpdated = 0;
      let totalFilesDeleted = 0;
      const errors = [];

      for (const collectionId of collectionIds) {
        try {
          const url = `/api/v1/collections/${encodeURIComponent(collectionId)}`;
          const response = await fetch(url, {
            method: 'DELETE',
            headers: {
              'X-Session-ID': state.sessionId
            }
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || `Delete failed: ${response.statusText}`);
          }

          const result = await response.json();
          totalFilesUpdated += result.files_updated;
          totalFilesDeleted += result.files_deleted;

          this.#logger.info(
            `Collection '${collectionId}' deleted: ${result.files_updated} files updated, ` +
            `${result.files_deleted} files deleted`
          );
        } catch (error) {
          this.#logger.error(`Failed to delete collection '${collectionId}': ${error}`);
          errors.push({ collectionId, error: /** @type {Error} */ (error).message });
        }
      }

      if (errors.length === 0) {
        let message;
        if (collectionIds.length === 1) {
          const collectionName = getCollectionName(collectionIds[0], state.collections || []);
          message = `Collection '${collectionName}' deleted successfully.`;
        } else {
          message = `${collectionIds.length} collections deleted successfully.`;
        }
        if (totalFilesUpdated > 0 || totalFilesDeleted > 0) {
          message += ` ${totalFilesUpdated} files updated, ${totalFilesDeleted} files deleted.`;
        }
        notify(message, "success", "check-circle");
      } else if (errors.length < collectionIds.length) {
        const successCount = collectionIds.length - errors.length;
        const errorCollections = errors.map(e => getCollectionName(e.collectionId, state.collections || [])).join(', ');
        notify(
          `${successCount} collections deleted, but ${errors.length} failed: ${errorCollections}`,
          "warning",
          "exclamation-triangle"
        );
      } else {
        notify(`Failed to delete all ${collectionIds.length} collections`, "danger", "exclamation-octagon");
      }

      this.#selectedCollections.clear();
      this.#updateExportButtonState();
      this.close();
      await this.getDependency('filedata').reload({ refresh: true });

    } catch (error) {
      this.#logger.error("Delete failed: " + String(error));
      notify(`Delete failed: ${/** @type {Error} */ (error).message}`, "danger", "exclamation-octagon");
    } finally {
      deleteButton.disabled = this.#selectedCollections.size === 0;
      deleteButton.loading = false;
    }
  }
}

export default FileSelectionDrawerPlugin;


/** @deprecated Use FileSelectionDrawerPlugin class directly */
export const plugin = FileSelectionDrawerPlugin;

//
// Helper function
//

/**
 * Creates a label for a document with optional lock icon and variant suffix
 * @param {string} label - The document label
 * @param {boolean} [isLocked] - Whether the document is locked
 * @param {string} [variantId] - Optional variant ID to append in brackets
 * @returns {string} HTML string with label, optional variant suffix, and optional lock icon
 */
function createDocumentLabel(label, isLocked, variantId) {
  const displayLabel = variantId ? `${label} [${variantId}]` : label;
  return isLocked === true
    ? `<span>${displayLabel}</span> <sl-icon name="file-lock2"></sl-icon>`
    : `<span>${displayLabel}</span>`;
}

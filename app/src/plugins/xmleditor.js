/**
 * The XML Editor plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { StatusDropdown } from '../modules/panels/widgets/status-dropdown.js'
 * @import { UIPart, SlDropdown, SlMenu } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 * @import { ToolBar } from '../modules/panels/tool-bar.js'
 * @import { xslViewerOverlayPart } from './xsl-viewer.js'
 * @import { UserData } from './authentication.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import ui, { updateUi } from '../ui.js'
import { testLog } from '../modules/test-log.js'
import { PanelUtils } from '../modules/panels/index.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { setDiagnostics } from '@codemirror/lint'
import { detectXmlIndentation } from '../modules/codemirror/codemirror-utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import FiledataPlugin from './filedata.js'
import { isGoldFile, userHasRole } from '../modules/acl-utils.js'
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import * as tei_utils from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from '../modules/xml-utils.js'
import Plugin from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import XmlEditorDraftStore from '../modules/xml-editor-draft-store.js'

/**
 * Adaptive draft save throttle (ms): well-formed typing is flushed less often, malformed
 * typing is flushed more aggressively so no keystroke is lost before the save can complete.
 */
const DRAFT_THROTTLE_MS_WELL_FORMED = 500;
const DRAFT_THROTTLE_MS_MALFORMED = 200;

// Register templates
await registerTemplate('xmleditor-headerbar', 'xmleditor-headerbar.html')
await registerTemplate('xmleditor-headerbar-right', 'xmleditor-headerbar-right.html')
await registerTemplate('xmleditor-toolbar', 'xmleditor-toolbar.html')
await registerTemplate('xmleditor-tei-buttons', 'xmleditor-tei-buttons.html')
await registerTemplate('xmleditor-import-export-buttons', 'xmleditor-import-export-buttons.html')
await registerTemplate('xmleditor-statusbar', 'xmleditor-statusbar.html')
await registerTemplate('xmleditor-statusbar-right', 'xmleditor-statusbar-right.html')

//
// UI
//

/**
 * XML editor headerbar navigation properties
 * @typedef {object} xmlEditorHeaderbarPart
 * @property {StatusText} titlePrefixWidget - The artifact type prefix widget (e.g. "Gold:" / "Version:")
 * @property {StatusText} titleWidget - The artifact label widget (editable by reviewers)
 * @property {StatusText} lastUpdatedWidget - The last updated widget
 * @property {StatusText} [readOnlyStatusWidget] - Read-only indicator (present when editor is read-only)
 */

/**
 * XML editor toolbar navigation properties
 * @typedef {object} xmlEditorToolbarPart
 * @property {StatusButton} prevDiffBtn - Previous diff button
 * @property {StatusButton} nextDiffBtn - Next diff button
 * @property {StatusButton} rejectAllBtn - Reject all changes button
 * @property {StatusButton} acceptAllBtn - Accept all changes button
 * @property {StatusButton} validateBtn - Validate XML button
 * @property {StatusButton} teiWizardBtn - TEI Wizard button (added by tei-wizard plugin)
 * @property {SlDropdown} xslViewerDropdown - XSL viewer dropdown (added by xsl-viewer plugin)
 * @property {StatusButton} xslViewerBtn - XSL viewer button (added by xsl-viewer plugin)
 * @property {SlMenu} xslViewerMenu - XSL viewer menu (added by xsl-viewer plugin)
 * @property {StatusButton} uploadBtn - Upload document button
 * @property {StatusButton} downloadBtn - Download document button
 * @property {StatusButton} revisionHistoryBtn - Revision history button (added by tei-tools plugin)
 */

/**
 * XML editor statusbar navigation properties
 * @typedef {object} xmlEditorStatusbarPart
 * @property {StatusSwitch} lineWrappingSwitch - Line wrapping toggle switch
 * @property {StatusButton} prevNodeBtn - Previous node navigation button
 * @property {StatusDropdown} xpathDropdown - XPath selector dropdown
 * @property {StatusButton} nextNodeBtn - Next node navigation button
 * @property {StatusText} nodeCounterWidget - Node counter display (index/size)
 * @property {StatusText} indentationStatusWidget - The indentation status widget
 * @property {StatusText} cursorPositionWidget - The cursor position widget
 */

/**
 * XML editor navigation properties
 * TODO This has become very complex and needs to be refactored into separate components
 * @typedef {object} xmlEditorPart
 * @property {UIPart<StatusBar, xmlEditorHeaderbarPart>} headerbar - The XML editor headerbar
 * @property {UIPart<ToolBar, xmlEditorToolbarPart>} toolbar - The XML editor toolbar
 * @property {UIPart<StatusBar, xmlEditorStatusbarPart>} statusbar - The XML editor statusbar
 * @property {UIPart<HTMLDivElement, xslViewerOverlayPart>} xslViewerOverlay - XSL transformation overlay (added by xsl-viewer plugin)
 */

class XmlEditorPlugin extends Plugin {
  static extensionPoints = [ep.validation.inProgress];

  /**
   * Extension point handler for `ep.validation.inProgress`.
   * Called when a validation cycle begins so the editor can defer save operations
   * until the in-flight validation promise settles.
   * Delegates to {@link XmlEditorPlugin#inProgress}.
   * @param {Promise<import('@codemirror/lint').Diagnostic[]>} promise
   */
  [ep.validation.inProgress](...args) { return this.inProgress(...args) }

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'xmleditor',
      deps: ['logger', 'client']
    });
    this.#xmlEditor = new NavXmlEditor('codemirror-container');
    this.#draftStore = new XmlEditorDraftStore({ logger: console });
  }

  get #logger() { return this.getDependency('logger') }
  get #client() { return this.getDependency('client') }

  // The NavXmlEditor instance
  /** @type {NavXmlEditor} */
  #xmlEditor;

  // Panel references (captured early in install())
  /** @type {UIPart<import('../modules/panels/status-bar.js').StatusBar, xmlEditorHeaderbarPart>} */
  #headerbar;
  /** @type {UIPart<import('../modules/panels/tool-bar.js').ToolBar, xmlEditorToolbarPart>} */
  #toolbar;
  /** @type {UIPart<import('../modules/panels/status-bar.js').StatusBar, xmlEditorStatusbarPart>} */
  #statusbar;
  /** @type {HTMLElement} */
  #xmlEditorEl;

  // Toolbar widget references
  /** @type {StatusButton} */
  #prevDiffBtn;
  /** @type {StatusButton} */
  #nextDiffBtn;
  /** @type {StatusButton} */
  #rejectAllBtn;
  /** @type {StatusButton} */
  #acceptAllBtn;
  /** @type {StatusButton} */
  #validateBtn;
  /** @type {StatusButton} */
  #uploadBtn;
  /** @type {StatusButton} */
  #downloadBtn;

  // Statusbar widget references
  /** @type {StatusSwitch} */
  #lineWrappingSwitch;

  // Status widgets
  /** @type {StatusText} */
  #titlePrefixWidget;
  /** @type {StatusText} */
  #titleWidget;
  /** @type {StatusText} */
  #lastUpdatedWidget;
  /** @type {StatusText|null} */
  #readOnlyStatusWidget = null;
  /** @type {StatusText} */
  #cursorPositionWidget;
  /** @type {StatusText} */
  #indentationStatusWidget;

  // Node navigation widgets
  /** @type {StatusButton} */
  #prevNodeBtn;
  /** @type {StatusDropdown} */
  #xpathDropdown;
  /** @type {StatusButton} */
  #nextNodeBtn;
  /** @type {StatusText} */
  #nodeCounterWidget;

  // State for node navigation
  /** @type {string|null} */
  #currentVariant = null;
  /** @type {object[]|null} */
  #cachedExtractors = null;
  /** @type {UserData|null} */
  #currentUser = null;
  /** @type {string|null} */
  #hashBeingSaved = null;

  // Draft persistence and save-status reporting
  /** @type {XmlEditorDraftStore} */
  #draftStore;
  /** @type {ReturnType<typeof setTimeout>|null} */
  #draftSaveTimeout = null;
  /** @type {StatusText|null} */
  #saveStatusWidget = null;
  /** @type {boolean} */
  #saveBlockedShownToUser = false;
  /** @type {string|null} */
  #lastLoadedStableId = null;
  /** @type {string} */
  #originalDocumentTitle = document.title;

  /**
   * Returns a proxy that exposes plugin-level methods alongside the NavXmlEditor API.
   * Plugin methods take precedence; all other property accesses fall through to the inner editor.
   * TODO: Add a dedciated accessor and refactor consuming plugins's calls accordingly
   * @returns {NavXmlEditor}
   */
  getApi() {
    const plugin = this;
    const inner = this.#xmlEditor;
    const pluginMethods = new Set(['addStatusbarWidget', 'removeStatusbarWidget', 'addHeaderbarWidget', 'removeHeaderbarWidget', 'setReadOnlyContext', 'addToolbarWidget', 'appendToEditor', 'saveIfDirty', 'openDocumentAtLine', 'inProgress']);
    return /** @type {NavXmlEditor} */ (new Proxy(inner, {
      get(_target, prop) {
        if (pluginMethods.has(String(prop))) {
          return /** @type {any} */ (plugin)[prop].bind(plugin);
        }
        const val = inner[/** @type {keyof NavXmlEditor} */ (prop)];
        return typeof val === 'function' ? val.bind(inner) : val;
      }
    }));
  }

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    // Capture panel references (panels are pre-existing DOM elements)
    this.#headerbar = ui.xmlEditor.headerbar;
    this.#toolbar = ui.xmlEditor.toolbar;
    this.#statusbar = ui.xmlEditor.statusbar;
    this.#xmlEditorEl = ui.xmlEditor;

    // Create headerbar widgets from templates and add to headerbar
    const headerbarLeftWidgets = createFromTemplate('xmleditor-headerbar');
    headerbarLeftWidgets.forEach(widget => {
      if (widget instanceof HTMLElement) {
        this.#headerbar.add(widget, 'left', 1);
      }
    });

    const headerbarRightWidgets = createFromTemplate('xmleditor-headerbar-right');
    headerbarRightWidgets.forEach(widget => {
      if (widget instanceof HTMLElement) {
        this.#headerbar.add(widget, 'right', 1);
      }
    });

    // Create statusbar widgets from templates and add to statusbar
    const statusbarLeftWidgets = createFromTemplate('xmleditor-statusbar');
    statusbarLeftWidgets.forEach(widget => {
      if (widget instanceof HTMLElement) {
        this.#statusbar.add(widget, 'left', 1);
      }
    });

    const statusbarRightWidgets = createFromTemplate('xmleditor-statusbar-right');
    statusbarRightWidgets.forEach((widget, index) => {
      if (widget instanceof HTMLElement) {
        this.#statusbar.add(widget, 'right', index + 1);
      }
    });

    // Create toolbar widgets from templates and add to toolbar
    const toolbarWidgets = createFromTemplate('xmleditor-toolbar');
    const toolbarPriorities = [104, 103, 102, 101, 100, 99]; // separator, prevDiff, nextDiff, separator, reject, accept
    toolbarWidgets.forEach((widget, index) => {
      if (widget instanceof HTMLElement) {
        this.#toolbar.add(widget, toolbarPriorities[index] || 1);
      }
    });

    // Create TEI action buttons and add to toolbar (to the left of upload/download)
    const teiButtons = createFromTemplate('xmleditor-tei-buttons');
    const teiButtonsPriorities = [52, 51]; // separator, validateBtn
    teiButtons.forEach((widget, index) => {
      if (widget instanceof HTMLElement) {
        this.#toolbar.add(widget, teiButtonsPriorities[index] || 1);
      }
    });

    // Create import/export buttons and add to toolbar (right side)
    const importExportButtons = createFromTemplate('xmleditor-import-export-buttons');
    const importExportPriorities = [50, 3, 2]; // spacer, upload, download
    importExportButtons.forEach((widget, index) => {
      if (widget instanceof HTMLElement) {
        this.#toolbar.add(widget, importExportPriorities[index] || 1);
      }
    });

    // Read-only status widget (added dynamically when needed)
    this.#readOnlyStatusWidget = PanelUtils.createText({
      text: 'Read-only',
      icon: 'lock-fill',
      variant: 'warning',
      name: 'readOnlyStatus'
    });

    // Save status widget (persistent visible indicator when auto-save cannot reach the server).
    // It is added to the headerbar (right) whenever auto-save is blocked (malformed XML, network
    // failure, save still in flight after long malformed edits, etc.) and removed once a
    // successful server save occurs. It replaces the earlier silent debug-level "Not saving" log.
    this.#saveStatusWidget = PanelUtils.createText({
      text: 'Unsaved changes',
      icon: 'exclamation-triangle-fill',
      variant: 'warning',
      name: 'saveStatus'
    });
    // Make it clickable so the user can see a concise explanation if they ask.
    this.#saveStatusWidget.clickable = true;
    this.#saveStatusWidget.tooltip = 'Auto-save is blocked. Click for details.';
    this.#saveStatusWidget.addEventListener('widget-click', () => {
      notify(
        'Auto-save is currently blocked, usually because the XML is not well-formed. ' +
        'Your edits are buffered locally (draft). Fix the XML errors or use File → Download ' +
        'to export a copy.',
        'warning',
        'exclamation-triangle'
      );
    });

    // Update UI to register named widgets (kept for cross-plugin ui access in access-control.js)
    updateUi();

    // Store headerbar widget references
    this.#titlePrefixWidget = this.#headerbar.titlePrefixWidget;
    this.#titleWidget = this.#headerbar.titleWidget;
    this.#lastUpdatedWidget = this.#headerbar.lastUpdatedWidget;

    // Make title widget clickable/dblclickable for copy and edit
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      this.#titleWidget.clickable = true;
      this.#titleWidget.dblclickable = true;
      this.#titleWidget.tooltip = 'Click to copy, doubleclick to edit';
      this.#titleWidget.addEventListener('widget-click', () => {
        const label = this.#titleWidget.text;
        if (label) {
          navigator.clipboard.writeText(label).then(() => {
            notify(`Artifact label copied to clipboard`, 'success', 'clipboard-check');
          }).catch(err => {
            this.#logger.error('Failed to copy to clipboard: ' + String(err));
            notify('Failed to copy to clipboard', 'danger', 'exclamation-triangle');
          });
        }
      });
      this.#titleWidget.addEventListener('widget-dblclick', () => this.#editArtifactLabel());
    }
    this.#indentationStatusWidget = this.#statusbar.indentationStatusWidget;
    this.#cursorPositionWidget = this.#statusbar.cursorPositionWidget;
    this.#lineWrappingSwitch = this.#statusbar.lineWrappingSwitch;

    // Store toolbar widget references
    this.#prevDiffBtn = this.#toolbar.prevDiffBtn;
    this.#nextDiffBtn = this.#toolbar.nextDiffBtn;
    this.#rejectAllBtn = this.#toolbar.rejectAllBtn;
    this.#acceptAllBtn = this.#toolbar.acceptAllBtn;
    this.#validateBtn = this.#toolbar.validateBtn;
    this.#uploadBtn = this.#toolbar.uploadBtn;
    this.#downloadBtn = this.#toolbar.downloadBtn;

    // Initialize line wrapping switch from stored preference
    const lineWrappingEnabled = this.#getLineWrappingPreference();
    this.#lineWrappingSwitch.checked = lineWrappingEnabled;

    // Attach event listeners to toolbar buttons
    this.#prevDiffBtn.addEventListener('widget-click', () => this.#xmlEditor.goToPreviousDiff());
    this.#nextDiffBtn.addEventListener('widget-click', () => this.#xmlEditor.goToNextDiff());
    this.#rejectAllBtn.addEventListener('widget-click', () => {
      this.#xmlEditor.rejectAllDiffs();
      this.getDependency('services').removeMergeView();
    });
    this.#acceptAllBtn.addEventListener('widget-click', () => {
      this.#xmlEditor.acceptAllDiffs();
      this.getDependency('services').removeMergeView();
    });

    // Attach event listeners to import/export buttons
    this.#uploadBtn.addEventListener('widget-click', () => {
      if (this.state) this.getDependency('services').uploadXml(this.state);
    });
    this.#downloadBtn.addEventListener('widget-click', () => {
      if (this.state) this.getDependency('services').downloadXml(this.state);
    });

    // Attach event listener to validate button
    this.#validateBtn.addEventListener('widget-click', async () => {
      this.#validateBtn.disabled = true;
      const diagnostics = await this.getDependency('tei-validation').validate();
      notify(`The document contains ${diagnostics.length} validation error${diagnostics.length === 1 ? '' : 's'}.`);
    });

    // selection => xpath state
    // Use setTimeout so the dispatchStateChange never fires inside an active state-update
    // propagation cycle (e.g. when selectByXpath triggers CodeMirror's synchronous update).
    this.#xmlEditor.on('selectionChanged', _data => {
      setTimeout(() => {
        if (this.state) {
          this.#onSelectionChange(this.state);
        }
      }, 0);
      this.#updateCursorPosition();
    });

    // manually show diagnostics if validation is disabled
    this.#xmlEditor.on('editorXmlNotWellFormed', diagnostics => {
      if (this.getDependency('tei-validation').isDisabled()) {
        let view = this.#xmlEditor.getView();
        try {
          const validDiagnostics = diagnostics.filter(d => {
            return d.from >= 0 && d.to > d.from && d.to <= view.state.doc.length;
          });
          view.dispatch(setDiagnostics(view.state, validDiagnostics));
        } catch (error) {
          this.#logger.warn('Error setting diagnostics: ' + String(error));
          try {
            view.dispatch(setDiagnostics(view.state, []));
          } catch (clearError) {
            this.#logger.warn('Error clearing diagnostics: ' + String(clearError));
          }
        }
      }
    });

    // Update cursor position when editor is ready
    this.#xmlEditor.on('editorReady', () => this.#updateCursorPosition());

    // Update cursor position on editor updates (typing, etc.)
    this.#xmlEditor.on('editorUpdate', () => this.#updateCursorPosition());

    // Schedule a local-draft save on every editor update so no typed content is lost
    // even while the server save is blocked (e.g. malformed XML, connection lost).
    this.#xmlEditor.on('editorUpdate', () => this.#scheduleDraftSave());

    // Handle indentation detection before loading XML
    this.#xmlEditor.on('editorBeforeLoad', (xml) => {
      const indentUnit = detectXmlIndentation(xml);
      this.#logger.debug(`Detected indentation unit: ${JSON.stringify(indentUnit)}`);
      this.#xmlEditor.configureIntenation(indentUnit, 4);
      this.#updateIndentationStatus(indentUnit);
    });

    // Restore line wrapping and xpath after XML is loaded
    this.#xmlEditor.on('editorAfterLoad', () => {
      testLog('XML_EDITOR_DOCUMENT_LOADED', { isReady: true });

      this.#xmlEditor.whenReady().then(async () => {
        this.#xmlEditor.setLineWrapping(this.#getLineWrappingPreference());

        // Offer to restore a local draft if one exists for this stable id and differs from
        // the freshly loaded server content. Drafts arise when a previous session ended while
        // auto-save was blocked (typically because the XML was malformed).
        const currentStableId = this.state?.xml ?? null;
        this.#lastLoadedStableId = currentStableId;
        if (currentStableId) {
          await this.#maybeRestoreDraft(currentStableId);
        }

        setTimeout(async () => {
          if (!this.state?.xpath && this.state?.variant) {
            const savedXpath = this.#getXpathPreference(this.state.variant);
            const items = this.#xpathDropdown.items || [];
            const savedXpathInItems = savedXpath && items.some(item => item.value === savedXpath);
            if (savedXpathInItems) {
              await this.dispatchStateChange({ xpath: `${savedXpath}[1]` });
            }
          }
        }, 0);
      });
    });

    // Add change handler for line wrapping toggle
    this.#lineWrappingSwitch.addEventListener('widget-change', (e) => {
      const enabled = e.detail.checked;
      this.#setLineWrappingPreference(enabled);
      this.#xmlEditor.setLineWrapping(enabled);
      this.#logger.debug(`Line wrapping ${enabled ? 'enabled' : 'disabled'}`);
    });

    // Capture Ctrl/Cmd+S to trigger XML download instead of browser save
    const xmlEditorContainer = document.getElementById('codemirror-container');
    if (xmlEditorContainer) {
      xmlEditorContainer.addEventListener('keydown', (evt) => {
        if ((evt.ctrlKey || evt.metaKey) && evt.key === 's') {
          evt.preventDefault();
          evt.stopPropagation();
          if (this.state) {
            this.getDependency('services').downloadXml(this.state);
          }
        }
      });
    }

    // Guard navigation when the editor has unsaved work or a buffered draft. This shows the
    // browser's built-in "Leave site?" confirmation. The actual wording is controlled by the
    // browser; we only need to assign a non-empty returnValue and preventDefault().
    window.addEventListener('beforeunload', (evt) => {
      const dirty = this.#xmlEditor.isDirty();
      const blocked = this.#saveStatusWidget?.isConnected;
      // Only prompt when there is risk of losing unsaved work. A clean editor never prompts.
      if (!dirty && !blocked) return;
      // Flush the draft synchronously so whatever is in the editor is recoverable on reload
      // even if the user chooses to leave. This is best-effort; localStorage writes are fast.
      this.#flushDraftNow();
      evt.preventDefault();
      // Legacy browsers require returnValue to be set to a non-empty string.
      evt.returnValue = 'You have unsaved changes in the XML editor.';
    });

    // Create node navigation widgets for statusbar center section
    this.#prevNodeBtn = PanelUtils.createButton({
      icon: 'chevron-left',
      tooltip: 'Previous node',
      name: 'prevNodeBtn'
    });

    this.#xpathDropdown = PanelUtils.createDropdown({
      placeholder: 'Select XPath...',
      name: 'xpathDropdown'
    });

    this.#nextNodeBtn = PanelUtils.createButton({
      icon: 'chevron-right',
      tooltip: 'Next node',
      name: 'nextNodeBtn'
    });

    this.#nodeCounterWidget = PanelUtils.createText({
      text: '(0/0)',
      name: 'nodeCounterWidget'
    });

    // Add navigation widgets to statusbar center section
    this.#statusbar.add(this.#prevNodeBtn, 'center', 0);
    this.#statusbar.add(this.#xpathDropdown, 'center', 0);
    this.#statusbar.add(this.#nextNodeBtn, 'center', 0);
    this.#statusbar.add(this.#nodeCounterWidget, 'center', 0);

    // Update UI to register navigation widgets
    updateUi();

    // Initially hide navigation widgets
    this.#setNavigationWidgetsVisible(false);

    // XPath dropdown change handler - navigate to first node when selecting xpath
    this.#xpathDropdown.addEventListener('widget-change', async (evt) => {
      const customEvt = /** @type {CustomEvent} */ (evt);
      const baseXpath = customEvt.detail.value;
      if (this.#currentVariant) {
        this.#setXpathPreference(this.#currentVariant, baseXpath);
      }
      await this.dispatchStateChange({ xpath: baseXpath ? `${baseXpath}[1]` : '' });
    });

    // Navigation button handlers
    this.#prevNodeBtn.addEventListener('widget-click', () => this.#changeNodeIndex(this.state, -1));
    this.#nextNodeBtn.addEventListener('widget-click', () => this.#changeNodeIndex(this.state, +1));

    // Counter click handler (allow direct index input)
    this.#nodeCounterWidget.addEventListener('click', () => this.#onClickSelectionIndex());
  }

  /**
   * Runs after all plugins are installed to configure xmleditor event handlers
   */
  async start() {
    this.#logger.debug(`Starting plugin "${this.name}" - configuring additional event handlers`);

    const validationStatusWidget = PanelUtils.createText({
      text: 'XML not valid',
      icon: 'exclamation-triangle-fill',
      variant: 'danger',
      name: 'validationStatus'
    });

    // save dirty editor content after an update
    this.#xmlEditor.on('editorUpdateDelayed', async () => await this.#saveIfDirty());

    // xml validation events - consolidated from start.js
    this.#xmlEditor.on('editorXmlNotWellFormed', diagnostics => {
      this.#logger.debug('XML is not well-formed', diagnostics);

      let view = this.#xmlEditor.getView();
      try {
        const validDiagnostics = diagnostics.filter(d => {
          return d.from >= 0 && d.to > d.from && d.to <= view.state.doc.length;
        });
        view.dispatch(setDiagnostics(view.state, validDiagnostics));
      } catch (error) {
        this.#logger.warn('Error setting XML not well-formed diagnostics: ' + String(error));
        try {
          view.dispatch(setDiagnostics(view.state, []));
        } catch (clearError) {
          this.#logger.warn('Error clearing diagnostics: ' + String(clearError));
        }
      }

      if (validationStatusWidget && !validationStatusWidget.isConnected) {
        this.#headerbar.add(validationStatusWidget, 'right', 2);
      }
      // @ts-ignore
      this.#xmlEditorEl.querySelector('.cm-content').classList.add('invalid-xml');
    });

    this.#xmlEditor.on('editorXmlWellFormed', async () => {
      // @ts-ignore
      this.#xmlEditorEl.querySelector('.cm-content').classList.remove('invalid-xml');
      try {
        this.#xmlEditor.getView().dispatch(setDiagnostics(this.#xmlEditor.getView().state, []));
      } catch (error) {
        this.#logger.warn('Error clearing diagnostics on well-formed XML: ' + String(error));
      }
      if (validationStatusWidget && validationStatusWidget.isConnected) {
        this.#headerbar.removeById(validationStatusWidget.id);
      }
    });

    // dis/enable diff buttons
    const diffBtns = [
      this.#prevDiffBtn,
      this.#nextDiffBtn,
      this.#rejectAllBtn,
      this.#acceptAllBtn
    ];
    const enableDiffButtons = (value) => {
      for (let btn of diffBtns) {
        btn.disabled = !value;
        btn.classList.toggle('xmleditor-toolbar-highlight', value);
      }
    };
    this.#xmlEditor.on(XMLEditor.EVENT_EDITOR_SHOW_MERGE_VIEW, () => {
      enableDiffButtons(true);
    });
    this.#xmlEditor.on(XMLEditor.EVENT_EDITOR_HIDE_MERGE_VIEW, () => {
      enableDiffButtons(false);
    });
    enableDiffButtons(false);
  }

  /**
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(_changedKeys, state) {
    // When diff is cleared externally (e.g. logout), hide the merge view
    if (!state.diff && this.#xmlEditor.isMergeViewActive()) {
      await this.#xmlEditor.hideMergeView();
    }

    // Track the currently loaded document so draft-save knows which key to write to.
    // We explicitly avoid clearing this on a null state.xml because `clear()` is called
    // during the transition — keep the last id until editorAfterLoad for the next document
    // reassigns it. The draft of the departed document remains on disk for later restore.
    if (state.xml && state.xml !== this.#lastLoadedStableId) {
      // Will be re-set in editorAfterLoad once load completes; defensively update here too.
      this.#lastLoadedStableId = state.xml;
    }

    // Invalidate extractor cache when user changes so it is refreshed lazily
    if (this.#currentUser !== state.user) {
      this.#currentUser = state.user;
      this.#cachedExtractors = null;
    }

    // Check if variant has changed, repopulate xpath dropdown
    if (this.#currentVariant !== state.variant) {
      this.#currentVariant = state.variant;
      await this.#populateXpathDropdown(state);
    }

    // Update navigation widget visibility based on dropdown content and document load state
    const hasNavigationPaths = this.#xpathDropdown.items && this.#xpathDropdown.items.length > 0
      && !this.#xpathDropdown.items[0].disabled;
    this.#setNavigationWidgetsVisible(hasNavigationPaths && Boolean(state.xml));

    // Update xpath selection and counter
    if (state.xpath) {
      let { index, pathBeforePredicates, nonIndexPredicates } = parseXPath(state.xpath);
      const nonIndexedPath = pathBeforePredicates + nonIndexPredicates;

      const optionValues = this.#xpathDropdown.items?.map(item => item.value) || [];
      const foundAtIndex = optionValues.indexOf(nonIndexedPath);
      if (foundAtIndex >= 0) {
        this.#xpathDropdown.selected = nonIndexedPath;
      } else {
        this.#xpathDropdown.selected = '';
      }

      this.#xmlEditor.whenReady().then(() => this.#updateNodeCounter(nonIndexedPath, index));
    }

    // Keep line wrapping switch always visible but disable when no document
    this.#lineWrappingSwitch.disabled = !state.xml;

    // Hide other statusbar widgets when no document
    ;[this.#cursorPositionWidget, this.#indentationStatusWidget]
      .forEach(widget => widget.style.display = state.xml ? 'inline-flex' : 'none');

    // Update title widgets with artifact type prefix and label
    const fileData = getFileDataById(state.xml);
    if (fileData?.item) {
      const versionType = isGoldFile(state.xml) ? 'Gold' : 'Version';
      this.#titlePrefixWidget.text = `${versionType}:`;
      this.#titleWidget.text = fileData.item.version_name || fileData.item.label || '';
    } else {
      this.#titlePrefixWidget.text = '';
      this.#titleWidget.text = '';
    }
    if (fileData?.item && fileData.item.last_update && fileData.item.last_updated_by) {
      const updateDate = new Date(fileData.item.last_update).toLocaleDateString();
      const updateTime = new Date(fileData.item.last_update).toLocaleTimeString();
      const lastUpdatedBy = fileData.item.last_updated_by?.replace('#', '');
      this.#lastUpdatedWidget.text = `Last revision: ${updateDate}, ${updateTime} by ${lastUpdatedBy}`;
    } else {
      this.#lastUpdatedWidget.text = '';
    }

    if (!state.xml) {
      this.#xmlEditor.clear();
      this.#xmlEditor.setReadOnly(true);
      this.#xmlEditorEl.classList.remove('editor-readonly');
      if (this.#readOnlyStatusWidget && this.#readOnlyStatusWidget.isConnected) {
        this.#headerbar.removeById(this.#readOnlyStatusWidget.id);
      }
      return;
    }

    // update the editor read-only state
    if (state.editorReadOnly !== this.#xmlEditor.isReadOnly()) {
      this.#xmlEditor.setReadOnly(state.editorReadOnly);
      this.#logger.debug(`Setting editor read-only state to ${state.editorReadOnly}`);
    }

    // Update visual indicators based on state
    if (state.editorReadOnly) {
      if (!this.#xmlEditorEl.classList.contains('editor-readonly')) {
        this.#xmlEditorEl.classList.add('editor-readonly');
      }
      if (this.#readOnlyStatusWidget) {
        this.#readOnlyStatusWidget.text = state.connectionLost ? 'Connection lost' : 'Read-only';
        this.#readOnlyStatusWidget.icon = state.connectionLost ? 'wifi-off' : 'lock-fill';
        if (!this.#readOnlyStatusWidget.isConnected) {
          this.#headerbar.add(this.#readOnlyStatusWidget, 'right', 5);
        }
      }
    } else {
      if (this.#xmlEditorEl.classList.contains('editor-readonly')) {
        this.#xmlEditorEl.classList.remove('editor-readonly');
      }
      if (this.#readOnlyStatusWidget && this.#readOnlyStatusWidget.isConnected) {
        this.#headerbar.removeById(this.#readOnlyStatusWidget.id);
      }
    }

    // Update import/export button states based on user role and state
    const isAnnotator = userHasRole(state.user, ['admin', 'reviewer', 'annotator']);
    if (isAnnotator) {
      this.#downloadBtn.disabled = !Boolean(state.xml);
      this.#uploadBtn.disabled = state.editorReadOnly || state.offline;
    } else {
      this.#downloadBtn.disabled = true;
      this.#uploadBtn.disabled = true;
    }

    // xpath state => selection
    if (this.#xmlEditor.isReady() && state.xpath && state.xml) {
      const { index, pathBeforePredicates } = parseXPath(state.xpath);
      try {
        const size = this.#xmlEditor.countDomNodesByXpath(pathBeforePredicates);
        const pathChanged = this.#xmlEditor.parentPath !== pathBeforePredicates;
        const indexChanged = index !== this.#xmlEditor.currentIndex;
        if (size > 0 && (pathChanged || indexChanged)) {
          this.#xmlEditor.parentPath = pathBeforePredicates;
          this.#xmlEditor.selectByIndex(index || 1);
        }
      } catch (e) {
        this.#logger.error(e);
      }
    }
  }

  /**
   * Invoked when a plugin starts a validation to disable the validate button
   * @param {Promise<any>} validationPromise
   */
  async inProgress(validationPromise) {
    this.#validateBtn.disabled = true;
    await validationPromise;
    this.#validateBtn.disabled = false;
  }

  //
  // Public methods (used by external plugins/sandbox)
  //

  /**
   * Save the current XML file if the editor is "dirty"
   */
  async saveIfDirty() {
    return this.#saveIfDirty();
  }

  /**
   * Add a widget to the XML editor statusbar.
   * @param {HTMLElement} widget
   * @param {'left'|'center'|'right'} position
   * @param {number} priority
   */
  addStatusbarWidget(widget, position, priority) {
    this.#statusbar.add(widget, position, priority)
  }

  /**
   * Remove a widget from the XML editor statusbar by ID.
   * @param {string} widgetId
   */
  removeStatusbarWidget(widgetId) {
    this.#statusbar.removeById(widgetId)
  }

  /**
   * Add a widget to the XML editor headerbar.
   * @param {HTMLElement} widget
   * @param {'left'|'center'|'right'} position
   * @param {number} priority
   */
  addHeaderbarWidget(widget, position, priority) {
    this.#headerbar.add(widget, position, priority)
  }

  /**
   * Remove a widget from the XML editor headerbar by ID.
   * @param {string} widgetId
   */
  removeHeaderbarWidget(widgetId) {
    this.#headerbar.removeById(widgetId)
  }

  /**
   * Set the context text on the read-only status widget.
   * @param {string} text
   */
  setReadOnlyContext(text) {
    if (this.#readOnlyStatusWidget) {
      this.#readOnlyStatusWidget.text = text
    }
  }

  /**
   * Add a widget to the XML editor toolbar.
   * @param {HTMLElement} widget
   * @param {number} priority
   */
  addToolbarWidget(widget, priority) {
    this.#toolbar.add(widget, priority)
  }

  /**
   * Append an element as a direct child of the XML editor panel (e.g. overlays).
   * @param {HTMLElement} element
   */
  appendToEditor(element) {
    this.#xmlEditorEl.appendChild(element)
  }

  /**
   * Open document and scroll to line
   * @param {string} stableId - Document stable ID
   * @param {number} lineNumber - Line number (1-based)
   * @param {number} [column=0] - Optional column position (0-based)
   */
  async openDocumentAtLine(stableId, lineNumber, column = 0) {
    await this.#xmlEditor.hideMergeView();
    await this.getDependency('services').load({ xml: stableId });
    await new Promise(resolve => requestAnimationFrame(resolve));
    this.#xmlEditor.scrollToLine(lineNumber, column);
  }

  //
  // Private methods
  //

  /**
   * @returns {boolean}
   */
  #getLineWrappingPreference() {
    const stored = localStorage.getItem('xmleditor.lineWrapping');
    return stored === null ? true : stored === 'true';
  }

  /**
   * @param {boolean} enabled
   */
  #setLineWrappingPreference(enabled) {
    localStorage.setItem('xmleditor.lineWrapping', String(enabled));
  }

  /**
   * @param {string} variantId
   * @returns {string|null}
   */
  #getXpathPreference(variantId) {
    return localStorage.getItem(`xmleditor.xpath.${variantId}`);
  }

  /**
   * @param {string} variantId
   * @param {string} xpath
   */
  #setXpathPreference(variantId, xpath) {
    if (xpath) {
      localStorage.setItem(`xmleditor.xpath.${variantId}`, xpath);
    } else {
      localStorage.removeItem(`xmleditor.xpath.${variantId}`);
    }
  }

  /**
   * Called when the selection in the editor changes to update the xpath state.
   * Only dispatches when a normative parentPath is active (i.e. the user has
   * selected a navigation path in the statusbar dropdown), so that random clicks
   * without a selected xpath type do not overwrite state.
   * @param {ApplicationState} state
   */
  async #onSelectionChange(state) {
    if (!this.#xmlEditor.parentPath) return;
    const selectedXpath = this.#xmlEditor.selectedXpath;
    if (!selectedXpath) {
      this.#logger.debug('Could not determine xpath of last selected node');
      return;
    }
    if (selectedXpath !== state.xpath) {
      await this.dispatchStateChange({ xpath: selectedXpath });
    }
  }

  /**
   * Save the current XML file if the editor is "dirty".
   *
   * The method is guarded against several failure modes that previously caused silent data
   * loss (see issue #358):
   *   - If the editor has no valid XML tree (malformed content), the server save is SKIPPED
   *     but the user is informed via a persistent headerbar widget, and the current editor
   *     content is still buffered to localStorage as a draft.
   *   - If the editor was mutated while a save was in flight (documentVersion changed), the
   *     editor is NOT marked clean, so the next delayed-update cycle will save again.
   *   - On save errors the user is notified via toast AND the persistent widget.
   */
  async #saveIfDirty() {
    const fileHash = this.state?.xml;
    const isHashBeingSaved = fileHash === this.#hashBeingSaved;
    const hasXmlTree = !!this.#xmlEditor.getXmlTree();
    const isDirty = this.#xmlEditor.isDirty();

    if (!fileHash) {
      // No document loaded – nothing to save, nothing to warn about.
      this.#setSaveBlocked(false);
      return;
    }
    if (isHashBeingSaved) {
      // A save is already in flight for this file hash; the delayed-update cycle will retry
      // once it completes. This is not a user-visible problem.
      this.#logger.debug('Not saving: Already saving document');
      return;
    }
    if (!isDirty) {
      this.#logger.debug("Not saving: Document hasn't changed");
      // Anything previously flagged blocked was user-facing; clear it on a clean state.
      this.#setSaveBlocked(false);
      return;
    }
    if (!hasXmlTree) {
      // This is the CRITICAL path for issue #358: the editor content is malformed so the
      // server cannot be reached without risking data corruption. The local draft save
      // (scheduled from editorUpdate) keeps the typed content safe. Tell the user.
      this.#logger.warn('Not saving to server: XML is not well-formed. ' +
        'Edits are buffered as a local draft until the XML can be parsed again.');
      this.#setSaveBlocked(true,
        'Unsaved – fix XML errors', 'exclamation-triangle-fill', 'warning');
      // Force a synchronous draft flush so nothing is in limbo if the tab is closed now.
      this.#flushDraftNow();
      return;
    }

    // Capture the document version BEFORE the save so we can detect edits that happened
    // during the await and avoid the race where we would otherwise mark a dirty editor
    // clean (dropping unsaved keystrokes).
    const versionAtStart = this.#xmlEditor.getDocumentVersion();

    try {
      this.#hashBeingSaved = fileHash;
      const filedata = FiledataPlugin.getInstance();
      const result = await filedata.saveXml(fileHash);
      if (!result || typeof result != 'object' || !result.status) {
        this.#logger.warn('Invalid result from filedata.saveXml: ' + result);
        this.#setSaveBlocked(true, 'Unsaved – server error', 'exclamation-octagon-fill', 'danger');
        return;
      }
      if (result.status == 'unchanged') {
        this.#logger.debug(`File has not changed`);
      } else {
        this.#logger.debug(`Saved file with file_id ${result.file_id}`);
        if (result.file_id && result.file_id !== fileHash) {
          await this.dispatchStateChange({ xml: result.file_id });
        }
      }

      const versionAtEnd = this.#xmlEditor.getDocumentVersion();
      if (versionAtEnd === versionAtStart) {
        // No edits happened during the save — safe to mark clean.
        this.#xmlEditor.markAsClean();
        // Server has an authoritative copy; drop the local draft to avoid stale restore prompts.
        if (this.#lastLoadedStableId) {
          this.#draftStore.clearDraft(this.#lastLoadedStableId);
        }
      } else {
        // Something was typed while saving; next delayed update will trigger another save.
        this.#logger.debug(
          `Document version advanced during save (${versionAtStart} -> ${versionAtEnd}); ` +
          'leaving dirty flag set so the next save cycle covers the new edits.'
        );
      }
      // Successful server save clears any previously shown warning.
      this.#setSaveBlocked(false);
    } catch (error) {
      this.#logger.error(error);
      notify(`Save failed: ${String(error)}`, 'danger', 'exclamation-octagon');
      this.#setSaveBlocked(true, 'Unsaved – save failed', 'exclamation-octagon-fill', 'danger');
      // Make sure a local draft exists in case the user reloads before the next retry.
      this.#flushDraftNow();
    } finally {
      this.#hashBeingSaved = null;
    }
  }

  /**
   * Toggle the persistent "unsaved" headerbar widget.
   * @param {boolean} blocked
   * @param {string} [text]
   * @param {string} [icon]
   * @param {'default'|'warning'|'danger'|'success'} [variant]
   */
  #setSaveBlocked(blocked, text = 'Unsaved changes', icon = 'exclamation-triangle-fill', variant = 'warning') {
    if (!this.#saveStatusWidget) return;
    if (blocked) {
      this.#saveStatusWidget.text = text;
      this.#saveStatusWidget.icon = icon;
      // StatusText variant attribute drives the CSS colour. Typed as string at runtime.
      /** @type {any} */ (this.#saveStatusWidget).variant = variant;
      if (!this.#saveStatusWidget.isConnected) {
        this.#headerbar.add(this.#saveStatusWidget, 'right', 1);
      }
      if (!this.#saveBlockedShownToUser) {
        this.#saveBlockedShownToUser = true;
        notify(
          'Auto-save is blocked. Your recent edits are buffered locally but not saved to the server. ' +
          'Fix XML errors or use File → Download to export a copy.',
          'warning',
          'exclamation-triangle'
        );
      }
    } else {
      if (this.#saveStatusWidget.isConnected) {
        this.#headerbar.removeById(this.#saveStatusWidget.id);
      }
      this.#saveBlockedShownToUser = false;
    }
    this.#updateBrowserTitle();
  }

  /**
   * Schedules a local-draft save with adaptive throttle: malformed content is flushed more
   * eagerly so no keystroke is lost before the next save can complete.
   */
  #scheduleDraftSave() {
    const stableId = this.#lastLoadedStableId ?? this.state?.xml ?? null;
    if (!stableId) return;
    const wellFormed = !!this.#xmlEditor.getXmlTree();
    const delay = wellFormed ? DRAFT_THROTTLE_MS_WELL_FORMED : DRAFT_THROTTLE_MS_MALFORMED;
    if (this.#draftSaveTimeout) clearTimeout(this.#draftSaveTimeout);
    this.#draftSaveTimeout = setTimeout(() => {
      this.#draftSaveTimeout = null;
      this.#flushDraftNow();
    }, delay);
    // Keep the tab title in sync with the dirty state.
    this.#updateBrowserTitle();
  }

  /**
   * Persists the current editor content to localStorage immediately. Safe to call at any time;
   * silently no-ops when there is no loaded document.
   */
  #flushDraftNow() {
    const stableId = this.#lastLoadedStableId ?? this.state?.xml ?? null;
    if (!stableId) return;
    try {
      const content = this.#xmlEditor.getEditorContent();
      if (!content) return;
      const wellFormed = !!this.#xmlEditor.getXmlTree();
      this.#draftStore.saveDraft(
        stableId,
        content,
        this.#xmlEditor.getDocumentVersion(),
        wellFormed
      );
    } catch (error) {
      this.#logger.warn('Failed to write local draft: ' + String(error));
    }
  }

  /**
   * If a local draft exists for the freshly loaded document and differs from the server
   * content, offer the user a chance to restore it. Declined drafts are discarded.
   * @param {string} stableId
   */
  async #maybeRestoreDraft(stableId) {
    let record;
    try {
      record = this.#draftStore.loadDraft(stableId);
    } catch (error) {
      this.#logger.warn('Failed to read local draft: ' + String(error));
      return;
    }
    if (!record) return;

    const serverContent = this.#xmlEditor.getEditorContent();
    if (record.content === serverContent) {
      // Draft matches server state – nothing to restore, clear the record.
      this.#draftStore.clearDraft(stableId);
      return;
    }

    const savedAt = new Date(record.savedAt).toLocaleString();
    const wellFormedTag = record.wellFormed ? 'well-formed' : 'MALFORMED';
    const shouldRestore = confirm(
      `A locally-buffered draft of this document was found from ${savedAt} (${wellFormedTag}).\n\n` +
      'This draft was created because auto-save could not reach the server. ' +
      'Restore the draft into the editor?\n\n' +
      'OK = restore draft (you can still save to the server once the XML is valid).\n' +
      'Cancel = discard draft and use the server version.'
    );

    if (!shouldRestore) {
      this.#draftStore.clearDraft(stableId);
      return;
    }

    try {
      await this.#xmlEditor.loadXml(record.content);
      notify('Local draft restored. Fix any XML errors and the document will auto-save.',
        'primary', 'info-circle');
      // The editor will re-emit editorUpdate events once the user types again; mark dirty
      // so the save cycle kicks in if the restored draft is itself well-formed.
      if (record.wellFormed) {
        // loadXml resets dirty to false; force a dirty save cycle by scheduling a draft flush.
        this.#scheduleDraftSave();
      } else {
        this.#setSaveBlocked(true, 'Unsaved – fix XML errors', 'exclamation-triangle-fill', 'warning');
      }
    } catch (error) {
      this.#logger.error('Failed to restore draft: ' + String(error));
      notify('Failed to restore draft: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Updates the browser tab title to reflect unsaved/error state. Prefixes the original
   * document title with "● " when there is unsaved work, or with "⚠ " when auto-save is
   * actively blocked, so users can notice from other tabs.
   */
  #updateBrowserTitle() {
    const base = this.#originalDocumentTitle;
    let prefix = '';
    const dirty = this.#xmlEditor.isDirty();
    const blocked = this.#saveStatusWidget?.isConnected;
    if (blocked) prefix = '⚠ ';
    else if (dirty) prefix = '● ';
    const newTitle = prefix + base;
    if (document.title !== newTitle) document.title = newTitle;
  }

  /**
   * Prompt the reviewer to rename the artifact label, add a TEI revision entry, and save.
   */
  async #editArtifactLabel() {
    if (!this.state?.xml) return;
    if (this.state.editorReadOnly) {
      notify('You are not allowed to edit this artifact', 'warning', 'exclamation-triangle');
      return;
    }
    // Refuse to mutate the in-memory DOM when it is stale relative to the editor buffer.
    // Overwriting the editor from a stale DOM tree would silently discard the user's
    // latest keystrokes (one of the root causes traced in issue #358).
    if (!this.#xmlEditor.isSynced()) {
      notify(
        'Cannot rename the artifact right now because the XML in the editor is not well-formed. ' +
        'Please fix the XML errors and try again.',
        'warning',
        'exclamation-triangle'
      );
      return;
    }
    const currentLabel = this.#titleWidget.text;
    const newLabel = prompt('Edit artifact label:', currentLabel);
    if (newLabel === null || newLabel.trim() === currentLabel) return;
    const trimmedLabel = newLabel.trim();

    try {
      const xmlDoc = this.#xmlEditor.getXmlTree();
      if (xmlDoc) {
        const fileData = getFileDataById(this.state.xml);
        const status = fileData?.file?.last_status || 'draft';
        tei_utils.addRevisionChange(xmlDoc, {
          status,
          persId: this.state.user.username,
          fullName: this.state.user.fullname,
          desc: `Renamed to ${trimmedLabel}`,
          label: trimmedLabel
        });
        prettyPrintXmlDom(xmlDoc, 'teiHeader');
        await this.#xmlEditor.updateEditorFromXmlTree();
        this.#xmlEditor.markAsClean();
        const filedata = FiledataPlugin.getInstance();
        await filedata.saveXml(this.state.xml);
      }

      await this.#client.apiClient.filesPatchMetadata(this.state.xml, { label: trimmedLabel });
      notify(`Artifact label updated to '${trimmedLabel}'`, 'success', 'check-circle');

      await this.getDependency('file-selection').reload({ refresh: true });
      await this.getDependency('services').load({ xml: this.state.xml });
    } catch (error) {
      this.#logger.error('Failed to update artifact label: ' + String(error));
      notify('Failed to update artifact label: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Updates the cursor position widget with current line and column
   */
  #updateCursorPosition() {
    if (!this.#xmlEditor.isReady() || !this.#cursorPositionWidget) return;
    const view = this.#xmlEditor.getView();
    const selection = view.state.selection.main;
    const line = view.state.doc.lineAt(selection.head);
    const lineNumber = line.number;
    const columnNumber = selection.head - line.from + 1;
    this.#cursorPositionWidget.text = `Ln ${lineNumber}, Col ${columnNumber}`;
  }

  /**
   * Updates the indentation status widget
   * @param {string} indentUnit
   */
  #updateIndentationStatus(indentUnit) {
    if (!this.#indentationStatusWidget) return;
    let displayText;
    if (indentUnit === '\t') {
      displayText = 'Indent: Tabs';
    } else {
      const spaceCount = indentUnit.length;
      displayText = `Indent: ${spaceCount} spaces`;
    }
    this.#indentationStatusWidget.text = displayText;
  }

  /**
   * @param {boolean} visible
   */
  #setNavigationWidgetsVisible(visible) {
    const display = visible ? 'inline-flex' : 'none';
    this.#prevNodeBtn.style.display = display;
    this.#xpathDropdown.style.display = display;
    this.#nextNodeBtn.style.display = display;
    this.#nodeCounterWidget.style.display = display;
  }

  /**
   * @param {string} xpath
   * @param {number|null} index
   */
  #updateNodeCounter(xpath, index) {
    let size;
    try {
      size = this.#xmlEditor.countDomNodesByXpath(xpath);
    } catch (e) {
      this.#logger.warn('Cannot update counter: ' + String(e));
      size = 0;
    }
    index = index || 1;
    this.#nodeCounterWidget.text = `(${size > 0 ? index : 0}/${size})`;
    this.#nextNodeBtn.disabled = this.#prevNodeBtn.disabled = size < 2;
  }

  /**
   * Navigate to previous/next node
   * @param {ApplicationState} state
   * @param {number} delta
   */
  async #changeNodeIndex(state, delta) {
    if (isNaN(delta)) {
      throw new TypeError('Second argument must be a number');
    }
    if (!state?.xpath) {
      return;
    }
    let { pathBeforePredicates, nonIndexPredicates, index } = parseXPath(state.xpath);
    const normativeXpath = pathBeforePredicates + nonIndexPredicates;
    const size = this.#xmlEditor.countDomNodesByXpath(normativeXpath);
    if (size < 2) {
      return;
    }
    if (index === null) index = 1;
    index += delta;
    if (index < 1) index = size;
    if (index > size) index = 1;
    const xpath = normativeXpath + `[${index}]`;
    await this.dispatchStateChange({ xpath });
  }

  /**
   * Called when the user clicks on the counter to enter the node index.
   * Dispatches a state change so the counter, dropdown, and editor stay in sync.
   */
  async #onClickSelectionIndex() {
    const index = prompt('Enter node index');
    if (!index) return;
    const parsedIndex = parseInt(index, 10);
    if (isNaN(parsedIndex) || !this.state?.xpath) return;
    try {
      const { pathBeforePredicates, nonIndexPredicates } = parseXPath(this.state.xpath);
      await this.dispatchStateChange({ xpath: `${pathBeforePredicates}${nonIndexPredicates}[${parsedIndex}]` });
    } catch (error) {
      this.#logger.warn('Failed to select by index: ' + String(error));
    }
  }

  /**
   * Populates the xpath dropdown based on the current variant
   * @param {ApplicationState} state
   */
  async #populateXpathDropdown(state) {
    const variantId = state.variant;

    if (!variantId) {
      this.#xpathDropdown.setItems([{ value: '', text: 'No variant selected', disabled: true }]);
      return;
    }

    if (this.#cachedExtractors === null) {
      try {
        this.#cachedExtractors = await this.#client.getExtractorList();
        this.#logger.debug('Loaded extractor list for node navigation');
      } catch (error) {
        this.#logger.warn('Failed to load extractor list: ' + String(error));
        this.#xpathDropdown.setItems([{ value: '', text: 'Error loading navigation paths', disabled: true }]);
        return;
      }
    }

    let navigationXpathList = null;
    for (const extractor of this.#cachedExtractors) {
      const navigationXpath = extractor.navigation_xpath?.[variantId];
      if (navigationXpath) {
        navigationXpathList = navigationXpath;
        break;
      }
    }

    if (!navigationXpathList) {
      this.#xpathDropdown.setItems([{ value: '', text: `No navigation paths for variant: ${variantId}`, disabled: true }]);
      return;
    }

    const items = navigationXpathList
      .filter(item => item.value !== null)
      .map(item => ({
        value: item.value,
        text: item.label
      }));

    this.#xpathDropdown.setItems(items);
  }
}

export default XmlEditorPlugin;

/** @deprecated Use XmlEditorPlugin class directly */
export const plugin = XmlEditorPlugin;


// Re-export XMLEditor class (used by external code)
export { XMLEditor };

// Wrapper functions for external use (backend-plugin-sandbox.js etc.)
export async function saveIfDirty() {
  return XmlEditorPlugin.getInstance().saveIfDirty();
}

export async function openDocumentAtLine(stableId, lineNumber, column = 0) {
  return XmlEditorPlugin.getInstance().openDocumentAtLine(stableId, lineNumber, column);
}

export async function inProgress(validationPromise) {
  return XmlEditorPlugin.getInstance().inProgress(validationPromise);
}

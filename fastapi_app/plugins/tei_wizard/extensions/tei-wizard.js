/**
 * @file Frontend Extension: TEI Wizard
 *
 * Adds the "Enhance TEI" button to the XML editor toolbar. It opens a dialog listing the
 * TEI enhancements registered with the tei-wizard backend plugin (its own and those of
 * dependent plugins, served as /api/plugins/tei-wizard/enhancements.js), runs the selected
 * ones on the current document and shows the result in the merge view.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { ApplicationState } from '../../../../app/src/state.js'
 */

/**
 * Enhancement execute function signature
 * @typedef {function(Document, ApplicationState, Map<string, any>): (Document|Promise<Document>)} EnhancementExecuteFunction
 */

/**
 * An enhancement registered by the enhancements.js bundle.
 * @typedef {object} EnhancementDef
 * @property {string} name - The name of the enhancement
 * @property {string} description - A brief description
 * @property {string} [pluginId] - The backend plugin that provided this enhancement
 * @property {EnhancementExecuteFunction} execute - The function to execute
 */

const ENHANCEMENTS_URL = '/api/plugins/tei-wizard/enhancements.js';

/** Position of the button in the XML editor toolbar */
const TOOLBAR_PRIORITY = 51.5;

export default class TeiWizardExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'tei-wizard', deps: ['logger', 'xmleditor', 'config', 'acl-utils', 'sl-utils', 'tei-utils', 'ui'] });
  }

  /** @type {EnhancementDef[]} */
  _enhancements = [];

  /** @type {HTMLElement|null} status-button in the XML editor toolbar */
  _button = null;

  /** @type {any} sl-dialog */
  _dialog = null;

  /** @type {HTMLElement|null} */
  _list = null;

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state);
    await this._loadEnhancements();

    this._button = document.createElement('status-button');
    this._button.setAttribute('name', 'teiWizardBtn');
    this._button.setAttribute('icon', 'magic');
    this._button.setAttribute('tooltip', 'Enhance TEI');
    this._button.setAttribute('action', 'tei-wizard');
    this._button.addEventListener('widget-click', () => this._runTeiWizard());
    this.getDependency('xmleditor').addToolbarWidget(this._button, TOOLBAR_PRIORITY);

    this._dialog = this._createDialog();
    document.body.appendChild(this._dialog);
    this._populateEnhancementList();
  }

  async onStateUpdate() {
    const state = this.state;
    if (!this._button || !state) return;
    const { userHasRole, isGoldFile } = this.getDependency('acl-utils');
    const isAnnotator = userHasRole(state.user, ['admin', 'reviewer', 'annotator']);
    const isReviewer = userHasRole(state.user, ['admin', 'reviewer']);
    /** @type {any} */ (this._button).disabled =
      !state.xml || state.editorReadOnly || !isAnnotator || (isGoldFile(state.xml) && !isReviewer);
  }

  /** Loads the enhancement bundle, which calls window.registerTeiEnhancement() for each enhancement */
  async _loadEnhancements() {
    const logger = this.getDependency('logger');
    window.registerTeiEnhancement = (/** @type {EnhancementDef} */ enhancement) => {
      if (!enhancement?.name || !enhancement.execute) {
        logger.warn('Invalid TEI enhancement: missing name or execute function');
        return;
      }
      this._enhancements = this._enhancements.filter(e => e.name !== enhancement.name);
      this._enhancements.push(enhancement);
    };
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = ENHANCEMENTS_URL;
      script.onload = () => {
        logger.debug(`Loaded ${this._enhancements.length} TEI enhancements from backend`);
        resolve(undefined);
      };
      script.onerror = () => {
        logger.warn('Failed to load TEI enhancements from backend');
        resolve(undefined);
      };
      document.head.appendChild(script);
    });
  }

  /** @returns {any} sl-dialog */
  _createDialog() {
    const dialog = document.createElement('sl-dialog');
    dialog.setAttribute('name', 'teiWizardDialog');
    dialog.setAttribute('label', 'TEI Wizard');
    dialog.classList.add('dialog-width');
    dialog.style.setProperty('--width', '50vw');
    dialog.innerHTML = `
      <div name="enhancementList"></div>
      <sl-button slot="footer" name="selectAll">Select All</sl-button>
      <sl-button slot="footer" name="selectNone">Select None</sl-button>
      <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
      <sl-button slot="footer" name="executeBtn" variant="primary">Execute</sl-button>`;
    this._list = dialog.querySelector('[name="enhancementList"]');
    const setAll = (/** @type {boolean} */ checked) => {
      this._list?.querySelectorAll('sl-checkbox').forEach(cb => { /** @type {any} */ (cb).checked = checked; });
    };
    dialog.querySelector('[name="selectAll"]')?.addEventListener('click', () => setAll(true));
    dialog.querySelector('[name="selectNone"]')?.addEventListener('click', () => setAll(false));
    return dialog;
  }

  _populateEnhancementList() {
    if (!this._list) return;
    const { escapeXml } = this.getDependency('tei-utils');
    this._list.innerHTML = '';
    for (const enhancement of this._enhancements) {
      const nameAttr = escapeXml(enhancement.name, { encodeQuotes: true });
      const nameText = escapeXml(enhancement.name);
      const description = escapeXml(enhancement.description || '', { encodeQuotes: true });
      this._list.insertAdjacentHTML('beforeend', `
    <sl-tooltip content="${description}" hoist placement="right">
      <sl-checkbox data-enhancement="${nameAttr}" size="medium">${nameText}</sl-checkbox>
    </sl-tooltip>
    <br />`);
    }
  }

  /** @returns {Promise<EnhancementDef[]>} The enhancements selected in the dialog, empty if cancelled */
  _getSelectedEnhancements() {
    const dialog = this._dialog;
    dialog.show();
    return new Promise((resolve) => {
      const cancel = dialog.querySelector('[name="cancel"]');
      const execute = dialog.querySelector('[name="executeBtn"]');
      const finish = (/** @type {EnhancementDef[]} */ result) => {
        cancel.removeEventListener('click', onCancel);
        execute.removeEventListener('click', onExecute);
        dialog.hide();
        resolve(result);
      };
      const onCancel = () => finish([]);
      const onExecute = () => {
        const selected = Array.from(this._list?.querySelectorAll('sl-checkbox') || [])
          .filter(cb => /** @type {any} */ (cb).checked)
          .map(cb => this._enhancements.find(e => e.name === /** @type {HTMLElement} */ (cb).dataset.enhancement))
          .filter(e => e !== undefined);
        finish(/** @type {EnhancementDef[]} */ (selected));
      };
      cancel.addEventListener('click', onCancel);
      execute.addEventListener('click', onExecute);
    });
  }

  async _runTeiWizard() {
    if (this.state?.editorReadOnly) return;
    const logger = this.getDependency('logger');
    const xmlEditor = this.getDependency('xmleditor');
    const config = this.getDependency('config');
    const { notify } = this.getDependency('sl-utils');
    const { encodeXmlEntities } = this.getDependency('tei-utils');
    const spinner = this.getDependency('ui').spinner;

    let teiDoc = xmlEditor.getXmlTree();
    if (!teiDoc) {
      logger.warn('TEI document not available.');
      return;
    }

    const selectedEnhancements = await this._getSelectedEnhancements();
    if (selectedEnhancements.length === 0) return;

    const configMap = config.toMap();
    for (const enhancement of selectedEnhancements) {
      try {
        const result = enhancement.execute(teiDoc, this.state, configMap);
        if (result instanceof Promise) {
          spinner.show(`Applying: ${enhancement.name}`);
          teiDoc = await result;
          spinner.hide();
        } else {
          teiDoc = result;
        }
      } catch (error) {
        spinner.hide();
        logger.error(`Error during enhancement "${enhancement.name}": ${String(error)}`);
        notify(`Enhancement "${enhancement.name}" failed: ${error.message}`, 'danger');
        return;
      }
    }

    let xmlstring = (new XMLSerializer()).serializeToString(teiDoc);
    xmlstring = xmlstring.replace(/(?<!<TEI[^>]*)\sxmlns=".+?"/, '');

    if (await config.get('xml.encode-entities.client')) {
      const encodeQuotes = await config.get('xml.encode-quotes', false);
      xmlstring = encodeXmlEntities(xmlstring, { encodeQuotes });
    }

    xmlEditor.showMergeView(xmlstring);
    notify(`${selectedEnhancements.length} TEI enhancements applied successfully.`, 'success');
  }
}

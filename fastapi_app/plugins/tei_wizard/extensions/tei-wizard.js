/**
 * @file Frontend Extension: TEI Wizard
 *
 * Adds the "Enhance TEI" dropdown to the XML editor toolbar. Its menu lists the TEI enhancements
 * registered with the tei-wizard backend plugin (its own and those of dependent plugins, served as
 * /api/plugins/tei-wizard/enhancements.js) that apply to the current document: those whose
 * `variants` include the document's variant and whose `appliesTo` test passes. Choosing an item
 * runs the enhancement on the current document and shows the result in the merge view.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { ApplicationState } from '../../../../app/src/state.js'
 * @import { XslAppliesTo } from '../../../../app/src/modules/xsl-applicability.js'
 */

/**
 * The execution environment passed to an enhancement as fourth argument
 * @typedef {object} EnhancementEnv
 * @property {string|null} variant - Variant id of the document
 * @property {string|null} unitPath - Review unit path configured for the variant, null if none or "auto"
 * @property {(doc: Document) => Element[]} findUnits - The review unit elements of a document ([] without a unit path)
 */

/**
 * Enhancement execute function signature
 * @typedef {function(Document, ApplicationState, Map<string, any>, EnhancementEnv): (Document|Promise<Document>)} EnhancementExecuteFunction
 */

/**
 * An enhancement registered by the enhancements.js bundle.
 * @typedef {object} EnhancementDef
 * @property {string} name - The name of the enhancement
 * @property {string} description - A brief description
 * @property {string} [pluginId] - The backend plugin that provided this enhancement
 * @property {EnhancementExecuteFunction} execute - The function to execute
 * @property {string[]} [variants] - Variant ids the enhancement is offered for (a trailing `*` matches a prefix); all if missing
 * @property {XslAppliesTo} [appliesTo] - Further test: an XPath expression or a function of the document
 */

const ENHANCEMENTS_URL = '/api/plugins/tei-wizard/enhancements.js';

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/** Priority of the dropdown in the plugin section of the XML editor toolbar (left of the XSL viewer, 50.5) */
const TOOLBAR_PRIORITY = 51.5;

export default class TeiWizardExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, {
      name: 'tei-wizard',
      deps: ['logger', 'xmleditor', 'config', 'acl-utils', 'sl-utils', 'tei-utils', 'ui', 'xsl-applicability', 'unit-review']
    });
  }

  /** @type {EnhancementDef[]} */
  _enhancements = [];

  /** @type {any} sl-button that opens the menu */
  _button = null;

  /** @type {any} sl-menu */
  _menu = null;

  /** @type {any} sl-tooltip around the dropdown */
  _tooltip = null;

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state);
    await this._loadEnhancements();

    const tooltip = document.createElement('sl-tooltip');
    tooltip.setAttribute('content', 'Enhance TEI');
    tooltip.innerHTML = `
      <sl-dropdown name="teiWizardDropdown" placement="bottom-end">
        <sl-button name="teiWizardBtn" variant="text" size="small" slot="trigger" disabled>
          <sl-icon name="magic"></sl-icon>
        </sl-button>
        <sl-menu name="teiWizardMenu"></sl-menu>
      </sl-dropdown>`;
    this._tooltip = tooltip;
    const dropdown = tooltip.querySelector('[name="teiWizardDropdown"]');
    this._button = tooltip.querySelector('[name="teiWizardBtn"]');
    this._menu = tooltip.querySelector('[name="teiWizardMenu"]');

    dropdown?.addEventListener('sl-show', () => {
      // the document may have changed since the menu was built
      this._updateMenu();
      dropdown.closest('tool-bar')?.classList.add('dropdown-open');
      this._tooltip?.hide();
    });
    dropdown?.addEventListener('sl-hide', () => {
      dropdown.closest('tool-bar')?.classList.remove('dropdown-open');
    });
    this._menu.addEventListener('sl-select', (/** @type {CustomEvent} */ event) => {
      const name = /** @type {HTMLElement} */ (event.detail.item).dataset.enhancement;
      if (name) this._runEnhancement(name);
    });

    const xmlEditor = this.getDependency('xmleditor');
    xmlEditor.addToolbarWidget(tooltip, TOOLBAR_PRIORITY, 'plugins');
    xmlEditor.on('editorAfterLoad', () => this._updateButtonState());
    xmlEditor.on('editorXmlWellFormed', () => this._updateButtonState());
    this._updateMenu();
  }

  async onStateUpdate() {
    this._updateButtonState();
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

  /**
   * Returns the enhancements that apply to the current document, sorted by name.
   * @returns {EnhancementDef[]}
   */
  _applicableEnhancements() {
    const xmlDoc = this.getDependency('xmleditor').getXmlTree();
    if (!xmlDoc) return [];
    const { stylesheetAppliesTo, variantMatches } = this.getDependency('xsl-applicability');
    const variant = this.getDependency('unit-review').getVariant();
    return this._enhancements
      .filter(e => variantMatches(e.variants, variant))
      .filter(e => stylesheetAppliesTo({ label: e.name, xmlns: TEI_NS, appliesTo: e.appliesTo }, xmlDoc))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Whether the current user may change the current document */
  _canEdit() {
    const state = this.state;
    if (!state?.xml || state.editorReadOnly) return false;
    const { userHasRole, isGoldFile } = this.getDependency('acl-utils');
    const isAnnotator = userHasRole(state.user, ['admin', 'reviewer', 'annotator']);
    const isReviewer = userHasRole(state.user, ['admin', 'reviewer']);
    return isAnnotator && !(isGoldFile(state.xml) && !isReviewer);
  }

  _updateButtonState() {
    if (!this._button) return;
    this._button.disabled = !this._canEdit() || this._applicableEnhancements().length === 0;
  }

  _updateMenu() {
    if (!this._menu) return;
    this._menu.innerHTML = '';
    const applicable = this._applicableEnhancements();
    if (applicable.length === 0) {
      const item = document.createElement('sl-menu-item');
      item.textContent = 'No enhancements for this document';
      /** @type {any} */ (item).disabled = true;
      this._menu.appendChild(item);
      return;
    }
    for (const enhancement of applicable) {
      const item = document.createElement('sl-menu-item');
      item.dataset.enhancement = enhancement.name;
      item.textContent = enhancement.name;
      if (enhancement.description) item.setAttribute('title', enhancement.description);
      this._menu.appendChild(item);
    }
  }

  /**
   * Returns the execution environment for the current document.
   * @returns {EnhancementEnv}
   */
  _env() {
    const unitReview = this.getDependency('unit-review');
    const unitPath = unitReview.getUnitPath();
    return {
      variant: unitReview.getVariant(),
      unitPath,
      findUnits: (/** @type {Document} */ doc) => unitReview.findUnitElements(doc, unitPath)
    };
  }

  /**
   * Runs an enhancement on the current document and shows the result in the merge view.
   * @param {string} name
   */
  async _runEnhancement(name) {
    const logger = this.getDependency('logger');
    const xmlEditor = this.getDependency('xmleditor');
    const config = this.getDependency('config');
    const { notify } = this.getDependency('sl-utils');
    const { encodeXmlEntities } = this.getDependency('tei-utils');
    const spinner = this.getDependency('ui').spinner;

    if (!this._canEdit()) return;
    // the document may have changed since the menu was opened
    const enhancement = this._applicableEnhancements().find(e => e.name === name);
    if (!enhancement) {
      notify(`"${name}" does not apply to this document.`, 'warning', 'exclamation-triangle');
      return;
    }
    let teiDoc = xmlEditor.getXmlTree();
    if (!teiDoc) {
      logger.warn('TEI document not available.');
      return;
    }

    try {
      const result = enhancement.execute(teiDoc, this.state, config.toMap(), this._env());
      if (result instanceof Promise) {
        spinner.show(`Applying: ${enhancement.name}`);
        try {
          teiDoc = await result;
        } finally {
          spinner.hide();
        }
      } else {
        teiDoc = result;
      }
    } catch (error) {
      logger.error(`Error during enhancement "${enhancement.name}": ${String(error)}`);
      notify(`Enhancement "${enhancement.name}" failed: ${error.message}`, 'danger', 'exclamation-octagon');
      return;
    }

    let xmlstring = (new XMLSerializer()).serializeToString(teiDoc);
    xmlstring = xmlstring.replace(/(?<!<TEI[^>]*)\sxmlns=".+?"/, '');

    if (await config.get('xml.encode-entities.client')) {
      const encodeQuotes = await config.get('xml.encode-quotes', false);
      xmlstring = encodeXmlEntities(xmlstring, { encodeQuotes });
    }

    xmlEditor.showMergeView(xmlstring);
    notify(`"${enhancement.name}" applied. Review the changes in the merge view.`, 'success', 'check-circle');
  }
}

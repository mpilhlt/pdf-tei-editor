/**
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { ApplicationState } from '../state.js'
 * @import { ValidationError } from './client.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { EditorView, ViewUpdate } from '@codemirror/view';
import { linter, lintGutter, forEachDiagnostic, setDiagnostics } from "@codemirror/lint";
import Plugin from '../modules/plugin-base.js';
import ep from '../extension-points.js';

class TeiValidationPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'tei-validation',
      deps: ['xmleditor', 'client']
    });
  }

  // Cached dependencies
  #logger;
  #client;
  #xmlEditor;

  // Private state
  #validatedVersion = null;
  #isDisabled = false;
  #validationInProgress = false;
  /** @type {Promise<Diagnostic[]>|null} */
  #validationPromise = null;
  /** @type {Diagnostic[]} */
  #lastDiagnostics = [];
  #modeCache;

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state);
    this.#logger = this.getDependency('logger');
    this.#client = this.getDependency('client');
    this.#xmlEditor = this.getDependency('xmleditor');
    this.#logger.debug(`Installing plugin "${this.name}"`);
    this.#xmlEditor.addLinter([
      linter(this.#lintSource.bind(this), { autoPanel: true, delay: 2000, needsRefresh: () => false }),
      lintGutter()
    ]);
    this.#xmlEditor.on('editorUpdateDelayed', (update) => this.#removeDiagnosticsInChangedRanges(update));
  }

  /**
   * @param {(keyof ApplicationState)[]} changedKeys
   * @param {ApplicationState} state
   */
  onStateUpdate(changedKeys, state) {
    if (!changedKeys.some(k => ['offline', 'editorReadOnly', 'xml'].includes(k))) return;
    if (state.offline || state.editorReadOnly || !state.xml) {
      this.configure({ mode: 'off' });
    } else {
      this.configure({ mode: 'auto' });
    }
  }

  static extensionPoints = ['validation.validate', 'validation.inProgress'];

  //
  // Public API
  //

  /**
   * Configures the validation mode.
   * @param {{ mode: string }} param0
   */
  configure({ mode = 'auto' }) {
    switch (mode) {
      case 'auto':
        this.#isDisabled = false;
        this.#logger.info('Validation is enabled');
        break;
      case 'off':
        this.#isDisabled = true;
        this.#logger.info('Validation is disabled');
        break;
      default:
        throw new Error('Invalid mode parameter');
    }
    this.#modeCache = mode;
  }

  /**
   * Triggers a validation and returns diagnostics.
   * @returns {Promise<Diagnostic[]>}
   */
  async validate() {
    if (this.#isValidating()) {
      this.#logger.debug('Validation is ongoing, waiting for it to finish');
      return await this.#anyCurrentValidation();
    }
    this.#clearDiagnostics();
    const prevDisabled = this.#isDisabled;
    this.#isDisabled = false;
    const diagnostics = await new Promise(resolve => {
      this.#logger.debug('Waiting for validation to start...');
      const check = () => {
        if (this.#isValidating()) {
          this.#anyCurrentValidation().then(resolve);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
    this.#isDisabled = prevDisabled;
    return diagnostics;
  }

  /**
   * Invoked when a validation starts; disables re-entrant validation.
   * @param {Promise<Diagnostic[]>} promise
   */
  async inProgress(promise) {
    this.#isDisabled = true;
    await promise;
    this.#isDisabled = false;
  }

  /** @returns {boolean} */
  isDisabled() { return this.#isDisabled; }

  /** @returns {boolean} */
  isValidDocument() { return this.#lastDiagnostics.length === 0; }

  getApi() { return this; }

  //
  // Private methods
  //

  /**
   * Lint source function passed to CodeMirror's linter extension.
   * @param {EditorView} view
   * @returns {Promise<Diagnostic[]>}
   */
  async #lintSource(view) {
    const doc = view.state.doc;
    const xml = doc.toString();

    if (xml === '') {
      this.#logger.debug('Nothing to validate.');
      return [];
    }
    if (this.#isDisabled) {
      this.#logger.debug('Ignoring validation request: Validation is disabled');
      return this.#lastDiagnostics;
    }
    if (this.#validationInProgress) {
      this.#logger.debug('Ignoring validation request: Validation is ongoing.');
      return this.#lastDiagnostics;
    }

    this.#validationInProgress = true;
    this.#validationPromise = new Promise(async (resolve) => {
      /** @type {ValidationError[]} */
      let validationErrors;
      while (true) {
        this.#validatedVersion = this.#xmlEditor.getDocumentVersion();
        this.#logger.debug(`Requesting validation for document version ${this.#validatedVersion}...`);
        this.context.invokePluginEndpoint(ep.validation.inProgress, [this.#validationPromise]);
        try {
          validationErrors = await this.#client.validateXml(xml);
        } catch (error) {
          this.#logger.warn(`Validation request failed: ${error.message}`);
          return resolve([]);
        }
        console.log(`Received validation results for document version ${this.#validatedVersion}: ${validationErrors.length} errors.`);
        if (this.#validatedVersion !== this.#xmlEditor.getDocumentVersion()) {
          this.#logger.debug('Document has changed, restarting validation...');
        } else {
          const diagnostics = validationErrors.map(error => {
            if (error.line === undefined || error.column === undefined) {
              throw new Error('Invalid response from remote validation:' + JSON.stringify(error));
            }
            const lineNum = Math.max(1, Math.min(error.line, doc.lines));
            let from, to;
            try {
              const line = doc.line(lineNum);
              from = line.from;
              to = line.to;
              const columnOffset = Math.max(0, Math.min(error.column, line.length));
              from = Math.max(0, Math.min(from + columnOffset, doc.length - 1));
              to = Math.min(Math.max(from + 1, to), doc.length);
              if (from >= to || from >= doc.length) {
                from = Math.max(0, Math.min(line.from, doc.length - 1));
                to = Math.min(from + 1, doc.length);
              }
            } catch (e) {
              console.warn(`Invalid line/column in validation error:`, error, e);
              from = 0;
              to = Math.min(1, doc.length);
            }
            return { from, to, severity: 'error', message: error.message || String(error), column: error.column };
          }).filter(Boolean);
          // @ts-ignore
          return resolve(diagnostics);
        }
      }
    });

    let diagnostics;
    try {
      diagnostics = await this.#validationPromise;
    } catch (error) {
      if (this.#client.lastHttpStatus && this.#client.lastHttpStatus >= 400) {
        this.#logger.warn('Disabling validation because of server error ' + this.#client.lastHttpStatus);
        this.configure({ mode: 'off' });
      }
      return this.#lastDiagnostics;
    } finally {
      this.#validationInProgress = false;
      this.#validationPromise = null;
    }

    this.#lastDiagnostics = diagnostics;
    this.context.invokePluginEndpoint(ep.validation.result, [diagnostics]);
    return diagnostics;
  }

  #clearDiagnostics() {
    this.#lastDiagnostics = [];
    this.#xmlEditor.getView().dispatch(setDiagnostics(this.#xmlEditor.getView().state, []));
  }

  #isValidating() { return this.#validationInProgress; }

  /** @returns {Promise<Diagnostic[]>} */
  #anyCurrentValidation() {
    return this.#validationInProgress && this.#validationPromise
      ? this.#validationPromise
      : Promise.resolve([]);
  }

  /**
   * @param {ViewUpdate} update
   */
  #removeDiagnosticsInChangedRanges(update) {
    const viewState = this.#xmlEditor.getView().state;
    /** @type {Diagnostic[]} */
    const diagnostics = [];
    // @ts-ignore — changedRanges is not in the types but exists at runtime
    const changedRangeValues = Object.values(update.changedRanges[0]);
    const minRange = Math.min(...changedRangeValues);
    const maxRange = Math.max(...changedRangeValues);
    forEachDiagnostic(viewState, (d) => {
      if (d.from > maxRange || d.to < minRange) {
        const docLength = viewState.doc.length;
        const validFrom = Math.max(0, Math.min(d.from, docLength - 1));
        const validTo = Math.min(Math.max(validFrom + 1, d.to), docLength);
        if (validFrom < validTo && validFrom < docLength) {
          diagnostics.push({ column: null, from: validFrom, to: validTo, severity: d.severity, message: d.message });
        }
      } else {
        this.#logger.debug('Removing diagnostic ' + JSON.stringify(d));
      }
    });
    this.#lastDiagnostics = diagnostics;
    try {
      this.#xmlEditor.getView().dispatch(setDiagnostics(viewState, diagnostics));
    } catch (error) {
      this.#logger.warn('Error setting diagnostics after range change:' + String(error));
      this.#xmlEditor.getView().dispatch(setDiagnostics(viewState, []));
      this.#lastDiagnostics = [];
    }

  }
}

export default TeiValidationPlugin;

/**
 * Lazy-proxy API for backward compatibility.
 * @deprecated Use `getDependency('tei-validation')` in plugins, or import `TeiValidationPlugin` directly.
 */
export const api = {
  configure: (...args) => TeiValidationPlugin.getInstance().configure(...args),
  validate: () => TeiValidationPlugin.getInstance().validate(),
  isValidDocument: () => TeiValidationPlugin.getInstance().isValidDocument(),
  isDisabled: () => TeiValidationPlugin.getInstance().isDisabled()
};

/** @deprecated Use TeiValidationPlugin class directly */
export const plugin = TeiValidationPlugin;

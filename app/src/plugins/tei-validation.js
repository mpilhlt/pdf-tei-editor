/**
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { ApplicationState } from '../state.js'
 * @import { ValidationError } from './client.js'
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 */

import { EditorView, ViewUpdate } from '@codemirror/view';
import { client, xmlEditor, pluginManager, logger, endpoints } from '../app.js'
import { linter, lintGutter, forEachDiagnostic, setDiagnostics } from "@codemirror/lint";

const api = {
  configure,
  validate,
  isValidDocument,
  isDisabled
}

/** @type {PluginConfig} */
const plugin = {
  name: "tei-validation",
  deps: ['xmleditor', 'client'],
  install,
  state: {update},
  validation: {
    validate,
    inProgress
  }
}

export { api, plugin }
export default plugin


//
// implementation
// 

let validatedVersion = null;
let _isDisabled = false;
let validationInProgress = false;
/** @type {Promise<Diagnostic[]>|null} */
let validationPromise = null;
/** @type {Diagnostic[]} */
let lastDiagnostics = [];

/**
 * @param {ApplicationState} state 
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // add the linter to the editor
  xmlEditor.addLinter([
    linter(lintSource, { 
      autoPanel: true, 
      delay: 2000, 
      needsRefresh: () => false
    }),
    lintGutter()
  ])
  // remove diagnostics in diffs 
  xmlEditor.on("editorUpdateDelayed", (updateData) => removeDiagnosticsInChangedRanges(updateData));
}

let modeCache;

/**
 * @param {ApplicationState} state 
 */
async function update(state) {
  // if we are offline, readonly or have no xml doc,  disable validation
  if (state.offline || state.editorReadOnly || !state.xml ) {
    configure({ mode: "off" })
  } else {
    configure({ mode: "auto" })
  }
} 

/**
 * Returns true if validation is disabled
 * @returns {boolean}
 */
function isDisabled() {
  return _isDisabled
}

/**
 * Invoked when this or another plugin starts a validation
 * @param {Promise<Diagnostic[]>} validationPromise 
 * @return {Promise<void>}
 */
async function inProgress(validationPromise) {
  // do not start validation if another one is going on
  _isDisabled = true
  await validationPromise
  _isDisabled = false
}

/**
 * Returns true if the last validation has found no errors
 * @returns {boolean}
 */
function isValidDocument() {
  return lastDiagnostics.length === 0
}

/**
 * The ListSource function, called by the editor
 * @param {EditorView} view The current editor object
 * @returns {Promise<Diagnostic[]>} An array of Diagnostic objects, or empty if validation passed without errors
 */
async function lintSource(view) {

  // get text from document
  const doc = view.state.doc;
  const xml = doc.toString();
  if (xml == "") {
    logger.debug("Nothing to validate.")
    return [];
  }

  // don't validate if disabled and use last diagnostics
  if (_isDisabled) {
    logger.debug("Ignoring validation request: Validation is disabled")
    return lastDiagnostics;
  }

  // if this is called while another validation is ongoing, return the last diagnostics
  if (validationInProgress) {
    logger.debug("Ignoring validation request: Validation is ongoing.")
    return lastDiagnostics;
  }

  validationInProgress = true;
  // promise that will resolve when the validation results are back from the server and the validation source is not outdated
  validationPromise = new Promise(async (resolve, reject) => {
    
    /** @type {ValidationError[]} */
    let validationErrors;
    while (true) {
      validatedVersion = xmlEditor.getDocumentVersion(); // rewrite this!
      logger.debug(`Requesting validation for document version ${validatedVersion}...`)
      // inform other plugins
      pluginManager.invoke(endpoints.validation.inProgress, validationPromise)
      // send request to server
      try {
        validationErrors = await client.validateXml(xml);
      } catch (error) {
        // Log as warning (not error) for recoverable issues like schema download failures
        logger.warn(`Validation request failed: ${error.message}`);
        return resolve([]);
      }
      console.log(`Received validation results for document version ${validatedVersion}: ${validationErrors.length} errors.`)
      // check if document has changed in the meantime
      if (validatedVersion != xmlEditor.getDocumentVersion()) {
        logger.debug("Document has changed, restarting validation...")
      } else {
        // convert xmllint errors to Diagnostic objects
        const diagnostics = validationErrors.map(error => {
          let from, to;
          if (error.line !== undefined && error.column !== undefined) {
            // Ensure line number is valid (1-based from validation, but doc.line expects 1-based)
            const lineNum = Math.max(1, Math.min(error.line, doc.lines));
            try {
              const line = doc.line(lineNum);
              from = line.from;
              to = line.to;
              // Ensure column is valid (0-based column position)
              const columnOffset = Math.max(0, Math.min(error.column, line.length));
              from = Math.max(0, Math.min(from + columnOffset, doc.length - 1));
              // Ensure 'to' position is valid and not beyond document end
              to = Math.min(Math.max(from + 1, to), doc.length);
              // Ensure from <= to and both are within document bounds
              if (from >= to || from >= doc.length) {
                from = Math.max(0, Math.min(line.from, doc.length - 1));
                to = Math.min(from + 1, doc.length);
              }
            } catch (e) {
              console.warn(`Invalid line/column in validation error:`, error, e);
              // Fallback to document start if line/column calculation fails
              from = 0;
              to = Math.min(1, doc.length);
            }
          } else {
            throw new Error("Invalid response from remote validation:" + JSON.stringify(error) )
          }
          const severity = "error"
          return { from, to, severity, message: error.message || String(error), column: error.column };
        }).filter(Boolean);
        // @ts-ignore
        return resolve(diagnostics)
      }
    }
  });

  let diagnostics;
  try {
    diagnostics = await validationPromise;
  } catch (error) {
    // stop querying
    if (client.lastHttpStatus && client.lastHttpStatus >= 400) {
      logger.warn("Disabling validation because of server error " + client.lastHttpStatus)
      configure({mode: "off"})
    }
    return lastDiagnostics
  } finally {
    validationInProgress = false;
    validationPromise = null;
  }

  // save the last diagnostics
  lastDiagnostics = diagnostics;
  // inform plugins
  pluginManager.invoke("validation.result", diagnostics)
  return diagnostics;
}

/**
 * Configures the validation
 * @param {object} param0 
 * @param {string} param0.mode The validation mode. Must be "auto" or "off". When "auto", validation is triggered on content
 *  changes in the editor.
 */
function configure({ mode = "auto" }) {
  switch (mode) {
    case "auto":
      _isDisabled = false
      logger.info("Validation is enabled")
      break
    case "off":
      _isDisabled = true
      logger.info("Validation is disabled")
      break
    default:
      throw new Error("Invalid mode parameter")
  }
  modeCache = mode
}

/**
  * Triggers a validation and returns an array of Diagnostic objects, or an empty array if no
  * validation errors were found
  * @returns {Promise<Diagnostic[]>}
  */
async function validate() {
  if (isValidating()) {
    // if a validation is ongoing, we can wait for it to finish and use the result
    logger.debug("Validation is ongoing, waiting for it to finish")
    return await anyCurrentValidation()
  }

  // otherwise, we trigger the linting

  // remove all diagnostics
  clearDiagnostics();

  // save disabled state and enable validation
  let disabledState = _isDisabled
  _isDisabled = false

  // await the new validation promise once it is available
  const diagnostics = await new Promise(resolve => {
    logger.debug("Waiting for validation to start...")
    function checkIfValidating() {
      if (isValidating()) {
        let validationPromise = anyCurrentValidation();
        validationPromise.then(resolve);
      } else {
        setTimeout(checkIfValidating, 100);
      }
    }
    checkIfValidating();
  });
  _isDisabled = disabledState
  return diagnostics
}

/**
 * Removes all diagnostics from the editor
 */
function clearDiagnostics() {
  updateCachedDiagnostics([])
  xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, []))
}


/**
 * Whether a validation is ongoing,
 * @returns {boolean}
 */
function isValidating() {
  return validationInProgress
}

/**
 * Returns a promise that resolves when an ongoing validation finishes with the result of that validation, 
 * or immediately with an empty array if no validation is currently taking place
 * @returns {Promise<Diagnostic[]>} An array of Diagnostic objects
 */
async function anyCurrentValidation() {
  //console.log("Current validation promise", validationPromise)
  return validationInProgress && validationPromise ? validationPromise : Promise.resolve([])
}

/**
 * Update the diagnostics list that is returned when the editor reqests a validation and the validation is disabled
 * @param {Diagnostic[]} diagnostics The updated list of diagnostics
 */
function updateCachedDiagnostics(diagnostics) {
  lastDiagnostics = diagnostics;
}

/**
 * Removes diagnostics that are within the edited range
 * @param {ViewUpdate} update 
 */
function removeDiagnosticsInChangedRanges(update) {
  const viewState = xmlEditor.getView().state
  /** @type {Diagnostic[]} */
  const diagnostics = []
  // @ts-ignore
  // update.changedRanges is not in the documentation but exists in the object
  const changedRangeValues = Object.values(update.changedRanges[0]) 
  const minRange = Math.min(...changedRangeValues)
  const maxRange = Math.max(...changedRangeValues)
  forEachDiagnostic(viewState, (d) => {
    if (d.from > maxRange || d.to < minRange) {
      // only keep diagnostics that are outside the changed range
      // Validate diagnostic positions before adding
      const docLength = viewState.doc.length;
      const validFrom = Math.max(0, Math.min(d.from, docLength - 1));
      const validTo = Math.min(Math.max(validFrom + 1, d.to), docLength);
      
      if (validFrom < validTo && validFrom < docLength) {
        diagnostics.push({
          column: null,
          from: validFrom,
          to: validTo,
          severity: d.severity,
          message: d.message
        });
      }
    } else {
      logger.debug("Removing diagnostic " + JSON.stringify(d))
    }
  });

  lastDiagnostics = diagnostics;

  // remove the diagnostics from the editor - add safety check
  try {
    xmlEditor.getView().dispatch(setDiagnostics(viewState, diagnostics));
  } catch (error) {
    logger.warn("Error setting diagnostics after range change:" + String(error));
    // Clear all diagnostics if there's an error
    xmlEditor.getView().dispatch(setDiagnostics(viewState, []));
    lastDiagnostics = [];
  }
}
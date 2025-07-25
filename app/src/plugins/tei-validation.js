/**
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { ApplicationState } from '../app.js'
 */

import { EditorView, ViewUpdate } from '@codemirror/view';
import { pluginManager, client, xmlEditor, invoke, logger, endpoints } from '../app.js'
import { linter, lintGutter, forEachDiagnostic, setDiagnostics } from "@codemirror/lint";
import { XMLEditor } from './xmleditor.js';

const api = {
  configure,
  validate,
  isValidDocument,
  isDisabled
}

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
let validationPromise = null;
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
  // listen for delayed editor updates
  // @ts-ignore
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_DELAYED_UPDATE, (evt) => removeDiagnosticsInChangedRanges(evt.detail));
}

let modeCache;

/**
 * @param {ApplicationState} state 
 */
async function update(state) {
  if (state.offline || state.editorReadOnly) {
    // if we are offline, disable validation
    configure({ mode: "off" })
  }
  //console.warn(plugin.name,"done") 
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
 * @param {Promise} validationPromise 
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
    let validationErrors;
    while (true) {
      validatedVersion = xmlEditor.getDocumentVersion(); // rewrite this!
      logger.debug(`Requesting validation for document version ${validatedVersion}...`)
      // inform other plugins
      invoke(endpoints.validation.inProgress, validationPromise)
      // send request to server
      try {
        validationErrors = await client.validateXml(xml);
      } catch (error) {
        return reject(error);
      }
      console.log(`Received validation results for document version ${validatedVersion}: ${validationErrors.length} errors.`)
      // check if document has changed in the meantime
      if (validatedVersion != xmlEditor.getDocumentVersion()) {
        logger.debug("Document has changed, restarting validation...")
      } else {
        // convert xmllint errors to Diagnostic objects
        const diagnostics = validationErrors.map(/** @type {object} */ error => {
          let from, to;
          if (error.line !== undefined && error.column !== undefined) {
            ({ from, to } = doc.line(error.line))
            from = from + error.column -1
          } else {
            throw new Error("Invalid response from remote validation:", error)
          }
          const severity = "error"
          return { from, to, severity, message: error.message };
        }).filter(Boolean);
        return resolve(diagnostics)
      }
    }
  });

  let diagnostics;
  try {
    diagnostics = await validationPromise;
  } catch (error) {
    // stop querying
    if (client.lastHttpStatus >= 400) {
      console.debug("Disabling validation because of server error " + client.lastHttpStatus)
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
    console.log("Waiting for validation to start...")
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
 * @returns {Promise<Array>} An array of Diagnostic objects
 */
async function anyCurrentValidation() {
  //console.log("Current validation promise", validationPromise)
  return isValidating() ? validationPromise : Promise.resolve([])
}

/**
 * Update the diagnostics list that is returned when the editor reqests a validation and the validation is disabled
 * @param {Array<Object>} diagnostics The updated list of diagnostics
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
  const diagnostics = []
  // @ts-ignore
  // update.changedRanges is not in the documentation but exists in the object
  const changedRangeValues = Object.values(update.changedRanges[0]) 
  const minRange = Math.min(...changedRangeValues)
  const maxRange = Math.max(...changedRangeValues)
  forEachDiagnostic(viewState, (d, from, to) => {
    if (d.from > maxRange || d.to < minRange) {
      // only keep diagnostics that are outside the changed range
      d.from = from;
      d.to = to;
      diagnostics.push(d);
    } else {
      logger.debug("Removing diagnostic " + JSON.stringify(d))
    }
  });

  lastDiagnostics = diagnostics;

  // remove the diagnostics from the editor
  xmlEditor.getView().dispatch(setDiagnostics(viewState, diagnostics));
}
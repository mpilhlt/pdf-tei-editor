import { EditorView } from 'codemirror';
import { app } from '../app.js'

let validatedVersion = null;
let isDisabled = false;
let validationInProgress = false;
let validationPromise = null; 
let lastDiagnostics = [];

/**
 * A anonymous class singleton that emits events concerning the validation
 */
export const validationEvents = new (class extends EventTarget {
  EVENT = {
    START: "validation-start",
    END: "validation-end"
  }
  constructor(){
    super()
  }
  emitStartEvent() {
    this.dispatchEvent(new Event(this.EVENT.START))
  }
  emitEndEvent() {
    this.dispatchEvent(new Event(this.EVENT.END))
  }
})

/**
 * Whether a validation is ongoing,
 * @returns {boolean}
 */
export function isValidating(){
  return validationInProgress
}

/**
 * Returns a promise that resolves when an ongoing validation finishes with the result of that validation, 
 * or immediately with an empty array if no validation is currently taking place
 * @returns {Promise<Array>} An array of Diagnostic objects
 */
export async function anyCurrentValidation() {
  //console.log("Current validation promise", validationPromise)
  return isValidating() ? validationPromise : Promise.resolve([])
}

/**
 * Disables the validation, i.e. any validation triggered returns an empty array
 * @param {boolean} value 
 */
export function disableValidation(value) {
  if (isDisabled !== value) {
    //console.log(`Validation ${value ? "disabled" : "enabled"}.`)
    isDisabled = value;
  }
}

/**
 * Returns whether the validation is disabled
 * @returns {boolean}
 */
export function validationIsDisabled() {
  return isDisabled;
}

/**
 * Update the diagnostics list that is returned when the editor reqests a validation and the validation is disabled
 * @param {Array<Object>} diagnostics The updated list of diagnostics
 */
export function updateCachedDiagnostics(diagnostics) {
  lastDiagnostics = diagnostics;
}

/**
 * The ListSource function 
 * @param {EditorView} view The current editor object
 * @returns {Array<>} An array of Diagnostic objects, or empty if validation passed without errors
 */
export async function lintSource(view) {

  // get text from document
  const doc = view.state.doc;
  const xml = doc.toString();
  if (xml == "") {
    console.log("Nothing to validate.")
    return [];
  }

  // don't even try if server has rejected our query before
  if (isDisabled) {
    //console.log("Ignoring validation request: Validation is disabled")
    return lastDiagnostics;
  }

  // if this is called while another validation is ongoing, return ok
  if (validationInProgress) {
    //console.log("Ignoring validation request: Validation is ongoing.")
    return lastDiagnostics;
  }
  validationInProgress = true;
  // promise that will resolve when the validation results are back from the server and the validation source is not outdated
  validationPromise = new Promise(async (resolve, reject) => {
    let validationErrors = [];
    while (true) {
      validatedVersion = window.app.xmleditor.getDocumentVersion(); // rewrite this!
      console.log(`Requesting validation for document version ${validatedVersion}...`)
      validationEvents.emitStartEvent()
      // send request to server
      try {
        ({ errors: validationErrors } = await app.client.validateXml(xml));
      } catch (error) {
        return reject(error);
      }
      // notify listeners that validation is done
      validationEvents.emitEndEvent()
      console.log(`Received validation results for document version ${validatedVersion}: ${validationErrors.length} errors.`)
      // check if document has changed in the meantime
      if (validatedVersion != window.app.xmleditor.getDocumentVersion()) {
        console.log("Document has changed, restarting validation...")
      } else {
        return resolve(validationErrors)
      }
    }
  });

  let validationErrors;
  try {
    validationErrors = await validationPromise;
  } catch (error) {
    // stop querying
    if (app.client.lastHttpStatus >= 400) {
      isDisabled = true
    }
    return lastDiagnostics
  } finally {
    validationInProgress = false;
    validationPromise = null;
  }

  // convert xmllint errors to Diagnostic objects
  const diagnostics = validationErrors.map(error => {
    let from, to;
    if (error.line !== undefined && error.column !== undefined) {
      ({ from, to } = doc.line(error.line))
      from += error.column
    } else {
      console.warn("Invalid response from remote validation:", error)
      return null
    }
    return { from, to, severity: "error", message: error.message };
  }).filter(Boolean);

  lastDiagnostics = diagnostics;
  return diagnostics;
}

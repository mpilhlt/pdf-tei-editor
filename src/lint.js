import { validateXml, last_http_status } from './client.js'
import { $ } from './utils.js'
import { resolveXPath } from './codemirror_utils.js'
import { EditorView } from 'codemirror';

let validatedVersion = null;
let isDisabled = false;
let validationInProgress = false;
let validationPromise = null; 
let lastDiagnostics = [];

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
  return validationPromise ? validationPromise : Promise.resolve([])
}

/**
 * Disables the validation, i.e. any validation triggered returns an empty array
 * @param {boolean} value 
 */
export function disableValidation(value) {
  if (isDisabled !== value) {
    console.log(`Validation ${value ? "disabled" : "enabled"}.`)
    isDisabled = value;
  }
}

export function validationIsDisabled() {
  return isDisabled;
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
    console.log("Ignoring validation request: Validation is disabled")
    return lastDiagnostics;
  }

  // if this is called while another validation is ongoing, return ok
  if (validationInProgress) {
    console.log("Ignoring validation request: Validation is ongoing.")
    return lastDiagnostics;
  }

  $('#btn-save-document').innerHTML = "Validating XML..."
  $('#btn-save-document').disabled = true;
  
  validationInProgress = true;
  // promise that will resolve when the validation results are back from the server and the validation source is not outdated
  validationPromise = new Promise(async (resolve, reject) => {
    while (true) {
      validatedVersion = window.xmlEditor.getDocumentVersion();
      console.log(`Requesting validation for document version ${validatedVersion}...`)
      let { errors: validationErrors } = await validateXml(xml);
      console.log(`Received validation results for document version ${validatedVersion}: ${validationErrors.length} errors.`)
      // check if document has changed in the meantime
      if (validatedVersion != window.xmlEditor.getDocumentVersion()) {
        console.log("Document has changed, restarting validation...")
      } else {
        return resolve(validationErrors)
      }
    }
  });

  let validation_errors;
  try {
    validation_errors = await validationPromise;
  } catch (error) {
    console.warn(error.message);
    // stop querying
    if (last_http_status == 403) {
      isDisabled = true
    }
  } finally {
    validationInProgress = false;
    validationPromise = null;
  }

  // convert xmllint errors to Diagnostic objects
  const diagnostics = validation_errors.map(error => {
    let from, to;
    if (error.line) {
      ({ from, to } = doc.line(error.line))
      from += error.col
    } else if (error.path) {
      // {"reason": "Unexpected child with tag 'tei:imprint' at position 4. Tag 'tei:title' expected.", 
      // "path": "/TEI/standOff/listBibl/biblStruct[8]/monogr"}  
      const pos = resolveXPath(view, error.path)
      if (!pos) {
        console.warn(`Could not locate ${error.path} in syntax tree.`)
        return null
      }
      ({ from, to } = pos);
    } else {
      console.warn("Invalid response from remote validation:", error)
      return null
    }
    return { from, to, severity: "error", message: error.reason };
  }).filter(Boolean);

  // (re-)enable save button
  $('#btn-save-document').innerHTML = "Validate & Save"
  $('#btn-save-document').disabled = false;

  lastDiagnostics = diagnostics;
  return diagnostics;
}

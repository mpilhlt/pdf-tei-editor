import { PdfTeiEditor } from '../app.js'

// name of the component
const name = "client"

let lastHttpStatus = null;

const api_base_url = '/api';

/**
 * component API
 */
const clientComponent = {
  get lastHttpStatus() {
    return lastHttpStatus
  },
  callApi,
  getFileList,
  validateXml,
  saveXml,
  extractReferences,
  loadInstructions,
  saveInstructions,
  deleteFiles
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent(name, clientComponent, name)
  console.log("Client plugin installed.")
}

/**
 * component plugin
 */
const clientPlugin = {
  name,
  app: { start }
}

export {clientComponent, clientPlugin}
export default clientPlugin


/**
 * A generic function to make API requests against the application backend. 
 * Expects a JSON response which is an arbitrary value in case of success or a 
 * `{errror: "Error message"}` object in case of an error handled by the API methods. 
 *
 * @param {string} endpoint - The API endpoint to call.
 * @param {string} method - The HTTP method to use (e.g., 'GET', 'POST').
 * @param {object} body - The request body (optional).  Will be stringified to JSON.
 * @returns {Promise<any>} - A promise that resolves to the response data,
 *                           or rejects with an error message if the request fails.
 */
async function callApi(endpoint, method, body = null) {
  try {
    const url = `${api_base_url}${endpoint}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      keepAlive: true
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    // send request
    const response = await fetch(url, options);
    let result;
    try {
      result = await response.json()
    } catch (jsonError) {
      throw new Error("Failed to parse error response as JSON:", jsonError);
    }
    // simple error protocol
    // we don't distinguish 400 and 500 errors for the moment, although this should probably be 
    // handled as warning and error, respectively 
    if (result && typeof result === "object" && result.error) {
      throw new Error(result.error);
    }
    return result
  } catch (error) {
    window.app.dialog.error(error.message)
    lastHttpStatus = error.status || 500;
    // rethrow
    throw error
  }
}

/**
 * Gets a list of pdf/tei files from the server, including their relative paths
 *
 * @returns {Promise<Array<{id,pdf,xml}>>} - A promise that resolves to an array of objects with keys "id", "pdf", and "tei".
 */
async function getFileList(xmlString) {
  return callApi('/files/list', 'GET');
}

/**
 * Lints a TEI XML string against the Flask API endpoint.
 *
 * @param {string} xmlString - The TEI XML string to validate.
 * @returns {Promise<Array<string>>} - A promise that resolves to an array of error messages,
 */
async function validateXml(xmlString) {
  return callApi('/validate', 'POST', { xml_string: xmlString });
}

/**
 * Saves the XML string to a file on the server.
 * @param {string} xmlString 
 * @param {string} filePath 
 * @returns {Promise<Object>}
 */
async function saveXml(xmlString, filePath) {
  return callApi('/files/save', 'POST', { xml_string: xmlString, file_path: filePath });
}

/**
 * Extracts the references from the given PDF and returns the XML with the extracted data
 * @param {string} pdfFileName The filename of the PDF to extract
 * @param {string?} doi The DOI of the document, if any
 * @returns {Promise<Object>}
 */
async function extractReferences(filename, doi = '') {
  return callApi('/extract', 'POST', { pdf: filename, doi });
}


/**
 * Returns the current prompt extraction instruction data
 * @returns {Promise<Array<Object>>} An array of {active,label,text} objects
 */
async function loadInstructions() {
  return callApi('/config/instructions', 'GET');
}

/**
 * Returns the current prompt extraction instruction data
 * @param {Array<Object>} instructions An array of {active,label,text} objects
 * @returns {Promise<Object>}
 */
async function saveInstructions(instructions) {
  if (!Array.isArray(instructions)) {
    throw new Error("Instructions must be an array");
  }
  // Check if all objects in the array have the required properties
  instructions.forEach(instruction => {
    if (typeof instruction.active !== 'boolean' || typeof instruction.label !== 'string' || typeof instruction.text !== 'string') {
      throw new Error("Each instruction must have 'active' (boolean), 'label' (string), and 'text' (string) properties");
    }
  });
  // Send the instructions to the server
  return callApi('/config/instructions', 'POST', instructions);
}


/**
 * Deletes all extraction document versions with the given timestamps 
 * @returns {Promise<void>}
 */
async function deleteFiles(filePaths) {
  if (!Array.isArray(filePaths)) {
    throw new Error("Timestamps must be an array");
  }
  return callApi('/files/delete', 'POST', filePaths);
}
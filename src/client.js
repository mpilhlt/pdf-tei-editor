export let last_http_status = null;
const api_base_url = '/api';

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
    alert(error.message)
    // rethrow
    throw error
  }
}

/**
 * Gets a list of pdf/tei files from the server, including their relative paths
 *
 * @returns {Promise<Array<{id,pdf,xml}>>} - A promise that resolves to an array of objects with keys "id", "pdf", and "tei".
 */
export async function getFileList(xmlString) {
  return callApi('/files/list', 'GET');
}

/**
 * Lints a TEI XML string against the Flask API endpoint.
 *
 * @param {string} xmlString - The TEI XML string to validate.
 * @returns {Promise<Array<string>>} - A promise that resolves to an array of error messages,
 */
export async function validateXml(xmlString) {
  return callApi('/validate', 'POST', { xml_string: xmlString });
}

/**
 * Saves the XML string to a file on the server.
 * @param {string} xmlString 
 * @param {string} filePath 
 * @returns {Promise<Object>}
 */
export async function saveXml(xmlString, filePath) {
  return callApi('/files/save', 'POST', { xml_string: xmlString, file_path: filePath });
}

/**
 * Extracts the references from the given PDF and returns  
 * @param {string} pdfFileName The filename of the PDF to extract, which has been uploaded to the server earlier 
 * @param {string?} doi The DOI of the document, if any
 * @returns {Promise<Object>}
 */
export async function extractReferences(filename, doi = '') {
  return callApi('/extract', 'POST', { pdf: filename, doi });
}

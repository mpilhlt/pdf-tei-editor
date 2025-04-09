export let last_http_status = null;
const api_base_url = '/api';

/**
 * A generic function to make API requests.
 *
 * @param {string} endpoint - The API endpoint to call.
 * @param {string} method - The HTTP method to use (e.g., 'GET', 'POST').
 * @param {object} body - The request body (optional).  Will be stringified to JSON.
 * @returns {Promise<any>} - A promise that resolves to the response data,
 *                           or rejects with an error message if the request fails.
 */
async function callApi(endpoint, method, body = null) {
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

  const response = await fetch(url, options);
  last_http_status = response.status;

  if (!response.ok) {
    let errorMessage = `HTTP error ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData && errorData.error) {
        errorMessage += `: ${errorData.error}`;
      }
    } catch (jsonError) {
      console.warn("Failed to parse error response as JSON:", jsonError);
    }
    throw new Error(errorMessage);
  }

  return await response.json();
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
 * @returns 
 */
export async function saveDocument(xmlString, filePath) {
  return callApi('/files/save', 'POST', { xml_string: xmlString, file_path: filePath });
}


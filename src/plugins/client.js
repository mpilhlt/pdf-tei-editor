/**
 * Plugin providing a link to server-side methods
 * This is not really a plugin as it does not implement any endpoints (yet)
 */


// name of the component
const name = "client"

let lastHttpStatus = null;

const api_base_url = '/api';
const upload_route = '/api/upload'

/**
 * plugin API
 */
const api = {
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
  deleteFiles,
  uploadFile,
  getConfigValue,
  setConfigValue
}


/**
 * component plugin
 */
const plugin = {
  name
}

export { api, plugin }
export default plugin



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
    window.dialog.error(error.message)
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
 * Saves the XML string to a file on the server, optionally as a new version
 * @param {string} xmlString 
 * @param {string} filePath 
 * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version 
 * @returns {Promise<Object>}
 */
async function saveXml(xmlString, filePath, saveAsNewVersion) {
  return callApi('/files/save', 'POST',
    { xml_string: xmlString, file_path: filePath, new_version: saveAsNewVersion });
}

/**
 * Extracts the references from the given PDF and returns the XML with the extracted data
 * @param {string} filename The filename of the PDF to extract
 * @param {Object} options The options for the extractions, such as DOI, additional instructions, etc. 
 * @returns {Promise<Object>}
 */
async function extractReferences(filename, options) {
  return callApi('/extract', 'POST', { pdf: filename, ...options });
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
 * @returns {Promise<Object>} The result object
 */
async function saveInstructions(instructions) {
  if (!Array.isArray(instructions)) {
    throw new Error("Instructions must be an array");
  }
  // Send the instructions to the server
  return callApi('/config/instructions', 'POST', instructions);
}


/**
 * Deletes all extraction document versions with the given timestamps 
 * @returns {Promise<Object>} The result object
 */
async function deleteFiles(filePaths) {
  if (!Array.isArray(filePaths)) {
    throw new Error("Timestamps must be an array");
  }
  return callApi('/files/delete', 'POST', filePaths);
}


/**
 * Retrieves a configuration value from the server
 */
async function getConfigValue(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Key must be a non-empty string");
  }
  const path = `/config/get/${encodeURIComponent(key)}`;
  const value = await callApi(path, 'GET');
  return value;
}

/**
 * Sets a configuration value on the server.
 */
async function setConfigValue(key, value) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Key must be a non-empty string");
  }

  const data = {
    key: key,
    value: value,
  };

  // The server is expected to return { result: "OK" } on success
  const response = await callApi('/config/set', 'POST', data);
  return response;
}


/**
 * Uploads a file selected by the user to a specified URL using `fetch()`.
 *
 * @author Gemini 2.0
 * @param {string} uploadUrl - The URL to which the file will be uploaded.
 * @param {object} [options={}] - Optional configuration options.
 * @param {string} [options.method='POST'] - The HTTP method to use for the upload.
 * @param {string} [options.fieldName='file'] - The name of the form field for the file.
 * @param {object} [options.headers={}] - Additional headers to include in the request.
 * @param {function} [options.onProgress] - A callback function to handle upload progress events.
 *        The function receives a progress event object as an argument.
 * @returns {Promise<Response>} - A Promise that resolves with the `Response` object
 *                             from the `fetch()` call or rejects with an error.
 * @example
 * // Async/Await example (requires an async function context):
 * async function myUploadFunction() {
 *   try {
 *     const response = await uploadFile('https://example.com/upload', {
 *       fieldName: 'my_file',
 *       headers: {
 *         'X-Custom-Header': 'value'
 *       },
 *       onProgress: (event) => {
 *         if (event.lengthComputable) {
 *           const percentComplete = (event.loaded / event.total) * 100;
 *           logger.info(`Uploaded: ${percentComplete.toFixed(2)}%`);
 *         } else {
 *           logger.info("Total size is unknown");
 *         }
 *       } 
 *     });
 *
 *     if (response.ok) {
 *       const data = await response.json();
 *       logger.info('Upload successful:', data);
 *     } else {
 *       throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
 *     }
 *   } catch (error) {
 *     console.error('Error uploading file:', error);
 *   }
 * }
 */
export async function uploadFile(uploadUrl = upload_route, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method = 'POST',
      fieldName = 'file',
      headers = {},
      onProgress,
    } = options;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf, .xml';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) {
        reject(new Error('No file selected.'));
        return;
      }
      const formData = new FormData();
      formData.append(fieldName, file);
      const fetchOptions = {
        method: method,
        body: formData,
        headers: headers
      };
      try {
        const response = await fetch(uploadUrl, fetchOptions);
        if (!response.ok) {
          reject(new Error(`HTTP error! Status: ${response.status}`));
          return;
        }
        let result = await response.json()
        if (result.error) {
          reject(result.error)
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });

    // Programmatically trigger the file chooser dialog.  Crucially, this must be initiated from a user action,
    // such as a button click, to work correctly in most browsers. Directly calling input.click() on page 
    // load will generally be blocked.
    input.click();
  });
}
/**
 * Plugin providing a link to server-side methods
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 */

import { logger, hasStateChanged } from '../app.js';
import { notify } from '../modules/sl-utils.js';

/**
 * Parent class for all API errors
 * @extends {Error}
 * @property {string} message - The error message
 * @property {number} statusCode - The HTTP status code associated with the error, defaults to 400
 */
class ApiError extends Error {
  /**
   * @param {string} message - The error message
   * @param {number} statusCode - The HTTP status code associated with the error, defaults to 400
   */  
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

/**
 * Error indicating that a resource is locked
 * @extends {ApiError}
 */
class LockedError extends ApiError {
  /**
   * @param {string} message - The error message
   * @param {number} statusCode - The HTTP status code associated with the error, defaults to 423
   */    
  constructor(message, statusCode = 423) {
    super(message);
    this.name = "LockedError";
    this.statusCode = statusCode;
  }
}

/**
 * Error indicating server-side connection issues, such as timeouts or unreachable endpoints.
 * @extends {ApiError}
 */
class ConnectionError extends ApiError {
  /**
   * @param {string} message - The error message
   * @param {number} statusCode - The HTTP status code associated with the error, defaults to 504
   */    
  constructor(message, statusCode = 504) {
    super(message);
    this.name = "ConnectError";
    this.statusCode = statusCode;
  }
}

/**
 * Error indicating an unexpected server-side error.
 * @extends {Error}
 * @property {number} statusCode - The HTTP status code associated with the error, defaults to 500
 * @property {string} name - The name of the error, defaults to "ApiError"
 * @property {string} message - The error message
 */
class ServerError extends Error {
  /**
   * @param {string} message - The error message
   * @param {number} statusCode - The HTTP status code associated with the error, defaults to 500
   */    
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "ServerError";
    this.statusCode = statusCode;
  }
}

// Current sessionId stored locally for API requests (updated when state changes)
/** @type {string|null} */
let sessionId = null;
/** @type {number|null} */
let lastHttpStatus = null;

const api_base_url = '/api';
const upload_route = api_base_url + '/files/upload'

/**
 * plugin API
 */
const api = {
  get lastHttpStatus() {
    return lastHttpStatus
  },
  ApiError,
  LockedError,
  ConnectionError,
  ServerError,
  callApi,
  getFileList,
  validateXml,
  getAutocompleteData,
  saveXml,
  extractReferences,
  getExtractorList,
  loadInstructions,
  saveInstructions,
  deleteFiles,
  createVersionFromUpload,
  uploadFile,
  getConfigData,
  setConfigValue,
  syncFiles,
  moveFiles,
  state,
  sendHeartbeat,
  checkLock,
  acquireLock,
  releaseLock,
  getAllLocks,
  getCacheStatus,
  login,
  logout,
  status
}


/**
 * component plugin
 * @type {PluginConfig}
 */
const plugin = {
  name: "client",
  state: {
    update
  }
}

export { api, plugin }
export default plugin

/**
 * @param {ApplicationState} state 
 */
async function update(state) {
  if (hasStateChanged(state, 'sessionId')) {
    sessionId = state.sessionId;
    logger.debug(`Setting session id to ${sessionId}`)
  }
  return sessionId
}

/**
 * A generic function to make API requests against the application backend. 
 * Expects a JSON response which is an arbitrary value in case of success or a 
 * `{errror: "Error message"}` object in case of an error handled by the API methods. 
 *
 * @param {string} endpoint - The API endpoint to call.
 * @param {string} method - The HTTP method to use (e.g., 'GET', 'POST').
 * @param {object|null} body - The request body (optional).  Will be stringified to JSON.
 * @param {Number} [retryAttempts] - The number of retry attempts after a timeout
 * @returns {Promise<any>} - A promise that resolves to the response data,
 *                           or rejects with an error message if the request fails.
 */
async function callApi(endpoint, method = 'GET', body = null, retryAttempts = 3) {
  const url = `${api_base_url}${endpoint}`;
  /** @type {RequestInit} */
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId || '',
    },
    keepalive: true
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  // function to send the request which can be repeatedly called in case of a timeout
  const sendRequest = async () => {

    // send request
    const response = await fetch(url, options);

    // save the last  HTTP status code for later use   
    lastHttpStatus = response.status

    let result;
    try {
      result = await response.json()
    } catch (jsonError) {
      throw new ServerError("Failed to parse error response as JSON");
    }

    if (response.status === 200) {
      // simple legacy error protocol if the server doesn't return a special status code
      // this is deprecated and should be removed
      if (result && typeof result === "object" && result.error) {
        throw new Error(result.error);
      }
      // success! 
      return result
    }

    // handle error responses
    const message = result.error

    // handle app-specific error types
    switch (response.status) {
      case 423:
        throw new LockedError(message)
      case 504:
        // Timeout
        throw new ConnectionError(message)
      default:
        // other 4XX errors
        if (response.status && String(response.status)[0] === '4') {
          throw new ApiError(message, response.status);
        }
        throw new ServerError(message);
    }
  }

  let error;
  do {
    try {
      // return the non-error result
      return await sendRequest()
    } catch (e) {
      error = e
      if (error instanceof ConnectionError) {
        // retry in case of ConnectionError
        logger.warn(`Connection error: ${error.message}. ${retryAttempts} retries remainig..`)
        // wait one second
        await new Promise(resolve => setTimeout(resolve, 1000))
      } else {
        // throw the error
        break;
      }
    }
  } while (retryAttempts-- > 0);

  // notify the user about server errors
  if (error instanceof ServerError) {
    notify(error.message, 'error');
  }
  throw error
}


/**
 * Logs in a user
 * @param {string} username
 * @param {string} passwd_hash
 * @returns {Promise<import('./authentication.js').UserData>}
 */
async function login(username, passwd_hash) {
  return await callApi('/auth/login', 'POST', { username, passwd_hash });
}

/**
 * Logs out the current user
 * @returns {Promise<any>}
 */
async function logout() {
  return await callApi('/auth/logout', 'POST', {});
}

/**
 * Checks the authentication status of the current user
 * @returns {Promise<any>}
 */
async function status() {
  return await callApi('/auth/status', 'GET');
}

/**
 * Gets a list of pdf/tei files from the server, including their relative paths
 *
 * @param {string|null} variant - Optional variant filter to apply
 * @param {boolean} refresh - Whether to force refresh of server cache
 * @returns {Promise<{id:string,pdf:string,xml:string}[]>} - A promise that resolves to an array of
 *  objects with keys "id", "pdf", and "tei".
 */
async function getFileList(variant = null, refresh = false) {
  const params = {};
  if (variant !== null) params.variant = variant;
  if (refresh) params.refresh = 'true';
  // @ts-ignore
  const queryString = new URLSearchParams(params).toString();
  const url = '/files/list' + (queryString ? '?' + queryString : '');
  return await callApi(url, 'GET');
}

/**
 * @typedef {object} ValidationError
 * @property {number} line
 * @property {number} column
 * @property {string} message
 */

/**
 * Lints a TEI XML string against the Flask API endpoint.
 *
 * @param {string} xmlString - The TEI XML string to validate.
 * @returns {Promise<ValidationError[]>} - A promise that resolves to an array of XML validation error messages,
 */
async function validateXml(xmlString) {
  return await callApi('/validate', 'POST', { xml_string: xmlString });
}

/**
 * Gets autocomplete data for the XML schema associated with the given XML string.
 *
 * @param {string} xmlString - The XML string containing schema information.
 * @returns {Promise<object>} - A promise that resolves to the autocomplete data object,
 *   which may be in a deduplicated format requiring resolution with resolveDeduplicated().
 */
async function getAutocompleteData(xmlString) {
  return await callApi('/validate/autocomplete-data', 'POST', { xml_string: xmlString });
}

/**
 * Saves the XML string to a file on the server, optionally as a new version
 * @param {string} xmlString 
 * @param {string} filePath 
 * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version 
 * @returns {Promise<Object>}
 */
async function saveXml(xmlString, filePath, saveAsNewVersion) {
  return await callApi('/files/save', 'POST',
    { xml_string: xmlString, file_path: filePath, new_version: saveAsNewVersion });
}

/**
 * Gets a list of available extraction engines
 * @returns {Promise<any[]>} Array of extractor information objects
 */
async function getExtractorList() {
  return await callApi('/extract/list', 'GET');
}

/**
 * Extracts the references from the given PDF and returns the XML with the extracted data
 * @param {string} filename The filename of the PDF to extract
 * @param {any} options The options for the extractions, such as DOI, additional instructions, etc. 
 * @returns {Promise<Object>}
 */
async function extractReferences(filename, options) {
  // Extract extractor ID from options for new API format
  const extractor = options.extractor || "llamore-gemini";
  const extractionOptions = { ...options };
  delete extractionOptions.extractor; // Remove extractor from options
  
  return await callApi('/extract', 'POST', { 
    pdf: filename, 
    extractor: extractor,
    options: extractionOptions 
  });
}

/**
 * Returns the current prompt extraction instruction data
 * @returns {Promise<Array<Object>>} An array of {active,label,text} objects
 */
async function loadInstructions() {
  return await callApi('/config/instructions', 'GET');
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
  return await callApi('/config/instructions', 'POST', instructions);
}


/**
 * Deletes all extraction document versions with the given timestamps 
 * @returns {Promise<Object>} The result object
 */
/**
 * @param {string[]} filePaths
 */
async function deleteFiles(filePaths) {
  if (!Array.isArray(filePaths)) {
    throw new Error("Timestamps must be an array");
  }
  return await callApi('/files/delete', 'POST', filePaths);
}

/**
 * Creates a new version of a file from an uploaded file.
 * @param {string} tempFilename 
 * @param {string} filePath 
 * @returns {Promise<Object>}
 */
async function createVersionFromUpload(tempFilename, filePath) {
  return await callApi('/files/create_version_from_upload', 'POST', { temp_filename: tempFilename, file_path: filePath });
}

/**
 * Retrieves the server application state
 * @returns {Promise<ApplicationState>}
 */
async function state() {
  return await callApi('/config/state')
}

/**
 * Synchronizes the files on the server with a (WebDav) Backend, if exists
 * @returns {Promise<Object>}
 */
async function syncFiles() {
  return await callApi('/files/sync')
}

/**
 * Moves the given files to a new collection
 * @param {string} pdf
 * @param {string} xml
 * @param {string} destinationCollection
 * @returns {Promise<{new_pdf_path: string, new_xml_path: string}>}
 */
async function moveFiles(pdf, xml, destinationCollection) {
  return await callApi('/files/move', 'POST', {
    pdf_path: pdf,
    xml_path: xml,
    destination_collection: destinationCollection
  });
}

/**
 * Returns all server-side configuration values for this application
 * @returns {Promise<Object>} 
 */
async function getConfigData() {
  return await callApi('/config/list', 'GET')
}

/**
 * Sets a configuration value on the server.
 * @param {string} key
 * @param {any} value
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
 * Sends a heartbeat to the server to keep the file lock alive.
 * @param {string} filePath The file path to send the heartbeat for
 * @returns {Promise<{status:string, cache_status:{dirty:boolean, last_modified:number|null, last_checked:number|null}}>} The response from the server 
 * @throws {Error} If the file path is not provided or if the heartbeat fails
 */
async function sendHeartbeat(filePath) {
  if (!filePath) {
    throw new Error("File path is required for heartbeat");
  }
  return await callApi('/files/heartbeat', 'POST', { file_path: filePath });
}

/**
 * Checks if a file is locked by another user.
 * @param {string} filePath The file path to check the lock for
 * @returns {Promise<{is_locked: boolean}>} The response from the server indicating if the file is locked
 * @throws {Error} If the file path is not provided or if the lock check fails
 */
async function checkLock(filePath) {
  if (!filePath) {
    throw new Error("File path is required to check lock");
  }
  return await callApi('/files/check_lock', 'POST', { file_path: filePath });
}

/**
 * @param {string} filePath
 */
async function acquireLock(filePath) {
  if (!filePath) {
    throw new Error("File path is required to check lock");
  }
  return await callApi('/files/acquire_lock', 'POST', { file_path: filePath });
}

/**
 * @param {string} filePath
 */
async function releaseLock(filePath) {
  if (!filePath) {
    throw new Error("File path is required to release lock");
  }
  return await callApi('/files/release_lock', 'POST', { file_path: filePath });
}


/**
 * Retrieves an object mapping all currently locked files to the session id that locked them.
 * @returns {Promise<{[key:string]:Number}>} An object mapping locked file paths to session ids 
 */
async function getAllLocks() {
  return await callApi('/files/locks', 'GET');
}

/**
 * Gets the current file data cache status from the server.
 * @returns {Promise<{dirty: boolean, last_modified: number|null, last_checked: number|null}>} Cache status object
 */
async function getCacheStatus() {
  return await callApi('/files/cache_status', 'GET');
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
 *    The function receives a progress event object as an argument.
 * @param {string} [options.accept='.pdf, .xml'] - The accepted file types for the file input.
 *    This is a string that will be set as the `accept` attribute of the file
 * @returns {Promise<Object>} - A Promise that resolves with the json-deserialized result
 *    from the `fetch()` call, which must be an object, or rejects with an error.
 *    The object should contain the uploaded file's metadata, such as its path or ID.
 *    It will always contain a key "originalFilename" with the original name of the file,
 *    (as the server can change the filename). Ff the upload fails on the server side, 
 *   it will contain an "error" key with the error message.
 * @throws {Error} If the upload fails or if no file is selected.
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
      accept = '.pdf, .xml'
    } = options;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) {
        reject(new Error('No file selected.'));
        return;
      }
      const formData = new FormData();
      console.debug("Uploading file:", file.name, "to", uploadUrl);
      formData.append(fieldName, file);
      const fetchOptions = {
        method: method,
        body: formData,
        headers: {
          ...headers,
          'X-Session-ID': sessionId || ''
        }
      };
      try {
        const response = await fetch(uploadUrl, fetchOptions);
        if (!response.ok) {
          reject(new Error(`HTTP error! Status: ${response.status}`));
          return;
        }
        let result = await response.json()
        if (typeof result !== 'object' || !result) {
          reject(new Error("Invalid response format, expected an object"));
          return;
        }
        // Ensure the result contains the original filename
        if (!result.originalFilename) {
          result.originalFilename = file.name; //   Fallback to the input file name
        }
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
/**
 * Plugin providing a link to server-side methods
 */

/**
 * @typedef {object} ErrorResponse
 * @property {string} error
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 * @import { AuthenticationData } from './authentication.js'
 */



import { logger, hasStateChanged } from '../app.js';
import { notify } from '../modules/sl-utils.js';
import { ApiClientV1 } from '../modules/api-client-v1.js';

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

const api_base_url = '/api/v1';
const upload_route = api_base_url + '/files/upload'

// Create singleton API client instance using the callApi function
const apiClient = new ApiClientV1(callApi);

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
  apiClient,
  callApi,
  getFileList,
  validateXml,
  getAutocompleteData,
  saveXml,
  extract,
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
  copyFiles,
  getCollections,
  createCollection,
  state,
  sendHeartbeat,
  checkLock,
  acquireLock,
  releaseLock,
  getAllLockedFileIds,
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
  let url = `${api_base_url}${endpoint}`;
  /** @type {RequestInit} */
  const options = {
    method,
    headers: {
      'X-Session-ID': sessionId || '',
    }
  };

  // Handle request body based on method and content type
  if (body !== null && body !== undefined) {
    if (method === 'GET') {
      // GET requests: convert body to query string
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value !== null && value !== undefined) {
          params.append(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += (url.includes('?') ? '&' : '?') + queryString;
      }
    } else if (body instanceof FormData) {
      // FormData (file uploads) - don't stringify or set Content-Type
      options.body = body;
      // Don't set Content-Type header - browser will set it with boundary
    } else {
      // POST/PUT/PATCH/DELETE with JSON body
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
  }
  // else: no body (valid for GET without params, DELETE without body, etc.)

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
    // FastAPI uses 'detail', Flask uses 'error'
    const message = result.detail || result.error

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
        logger.warn(`Connection error: ${String(error)}. ${retryAttempts} retries remainig..`)
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
    notify(String(error), 'error');
  }
  throw error
}


/**
 * Logs in a user
 * @param {string} username
 * @param {string} passwd_hash
 * @returns {Promise<AuthenticationData>}
 */
async function login(username, passwd_hash) {
  return await apiClient.authLogin({ username, passwd_hash });
}

/**
 * Logs out the current user
 * @returns {Promise<any>}
 */
async function logout() {
  return await apiClient.authLogout();
}


/**
 * Checks the authentication status of the current user
 * @returns {Promise<AuthenticationData>}
 */
async function status() {
  return await apiClient.authStatus();
}


/**
 * Gets a list of pdf/tei files from the server, including their relative paths
 *
 * @import { DocumentItem } from '../modules/file-data-utils.js'
 * @param {string|null} variant - Optional variant filter to apply
 * @param {boolean} refresh - Whether to force refresh of server cache
 * @returns {Promise<DocumentItem[]>} - A promise that resolves to an array of document items
 */
async function getFileList(variant = null, refresh = false) {
  // Build query params object
  const params = {};
  if (variant !== null) params.variant = variant;
  if (refresh) params.refresh = refresh;

  // Use generated client with query params (callApi handles GET query string conversion)
  return await apiClient.filesList(params);
}

/**
 * @typedef {object} ValidationError
 * @property {number} line
 * @property {number} column
 * @property {string} message
 */

/**
 * Lints a TEI XML string against the FastAPI validation endpoint.
 *
 * @param {string} xmlString - The TEI XML string to validate.
 * @returns {Promise<ValidationError[]>} - A promise that resolves to an array of XML validation error messages,
 */
async function validateXml(xmlString) {
  const response = await apiClient.validate({ xml_string: xmlString });
  return response.errors || [];
}

/**
 * Gets autocomplete data for the XML schema associated with the given XML string.
 *
 * @param {string} xmlString - The XML string containing schema information.
 * @param {boolean} [invalidateCache] - Whether to use cached data (false, default) or reload any required data (true)
 * @returns {Promise<Record<string, any>>} - A promise that resolves to the autocomplete data object,
 *   which may be in a deduplicated format requiring resolution with resolveDeduplicated().
 */
async function getAutocompleteData(xmlString, invalidateCache ) {
  const response = await apiClient.validateAutocompleteData({ xml_string: xmlString, invalidate_cache: invalidateCache });
  return response.data;
}

/**
 * Saves the XML string to a file on the server, optionally as a new version
 * @param {string} xmlString
 * @param {string} fileId
 * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version
 * @returns {Promise<Object>}
 */
async function saveXml(xmlString, fileId, saveAsNewVersion) {
  return await apiClient.filesSave({
    xml_string: xmlString,
    file_id: fileId,
    new_version: saveAsNewVersion
  });
}

/**
 * Gets a list of available extraction engines
 * @returns {Promise<any[]>} Array of extractor information objects
 */
async function getExtractorList() {
  return await apiClient.extractList();
}

/**
 * Extract content from a source document using specified extractor
 * @param {string} file_id The file ID/hash of the source document to extract from
 * @param {any} options The options for the extraction, including extractor type and specific options
 * @returns {Promise<Object>}
 */
async function extract(file_id, options) {
  // Extract extractor ID from options for new API format
  const extractor = options.extractor || "llamore-gemini";
  const extractionOptions = { ...options };
  delete extractionOptions.extractor; // Remove extractor from options

  return await apiClient.extract({
    file_id: file_id,
    extractor: extractor,
    options: extractionOptions
  });
}

/**
 * Returns the current prompt extraction instruction data
 * @returns {Promise<Array<Object>>} An array of {active,label,text} objects
 */
async function loadInstructions() {
  return await apiClient.configListInstructions();
}

/**
 * Saves the prompt extraction instruction data
 * @param {Array<Object>} instructions An array of {active,label,text} objects
 * @returns {Promise<Object>} The result object
 */
async function saveInstructions(instructions) {
  if (!Array.isArray(instructions)) {
    throw new Error("Instructions must be an array");
  }
  // Send the instructions to the server
  return await apiClient.configSaveInstructions({ instructions });
}


/**
 * Deletes all extraction document versions with the given file IDs
 * @param {string[]} fileIds
 * @returns {Promise<Object>} The result object
 */
async function deleteFiles(fileIds) {
  if (!Array.isArray(fileIds)) {
    throw new Error("File IDs must be an array");
  }
  return await apiClient.filesDelete({ files: fileIds });
}

/**
 * Creates a new version of a file from an uploaded file.
 * @param {string} tempFilename
 * @param {string} fileId
 * @returns {Promise<Object>}
 */
async function createVersionFromUpload(tempFilename, fileId) {
  return await apiClient.filesCreateVersionFromUpload({
    temp_filename: tempFilename,
    file_id: fileId
  });
}

/**
 * Retrieves the server application state
 * @returns {Promise<ApplicationState>}
 */
async function state() {
  return await apiClient.configState();
}


/**
 * Synchronizes the files on the server with a (WebDav) Backend, if exists
 * @returns {Promise<import('./sync.js').SyncResult>}
 */
async function syncFiles() {
  return await apiClient.sync({});
}

/**
 * Moves the given files to a new collection
 * @param {string} pdf - PDF file ID
 * @param {string} xml - XML file ID
 * @param {string} destinationCollection - Destination collection ID
 * @returns {Promise<{new_pdf_id: string, new_xml_id: string}>}
 */
async function moveFiles(pdf, xml, destinationCollection) {
  return await apiClient.filesMove({
    pdf_id: pdf,
    xml_id: xml,
    destination_collection: destinationCollection
  });
}

/**
 * Copies the given files to an additional collection
 * @param {string} pdf - PDF file ID
 * @param {string} xml - XML file ID
 * @param {string} destinationCollection - Destination collection ID
 * @returns {Promise<{new_pdf_id: string, new_xml_id: string}>}
 */
async function copyFiles(pdf, xml, destinationCollection) {
  return await apiClient.filesCopy({
    pdf_id: pdf,
    xml_id: xml,
    destination_collection: destinationCollection
  });
}

/**
 * Gets the list of collections accessible to the current user
 * @returns {Promise<{collections: Array<{id: string, name: string, description: string}>}>}
 */
async function getCollections() {
  return await apiClient.listCollections();
}

/**
 * Creates a new collection
 * @param {string} id - Collection ID (only letters, numbers, hyphens, underscores)
 * @param {string} [name] - Display name (defaults to id if not provided)
 * @param {string} [description] - Collection description
 * @returns {Promise<{success: boolean, message: string, collection: {id: string, name: string, description: string}}>}
 */
async function createCollection(id, name, description = "") {
  return await apiClient.createCollections({
    id,
    name: name || id,
    description
  });
}

/**
 * Returns all server-side configuration values for this application
 * @returns {Promise<Object>}
 */
async function getConfigData() {
  return await apiClient.configList();
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

  // The server is expected to return { result: "OK" } on success
  return await apiClient.configSet({ key, value });
}

/**
 * Sends a heartbeat to the server to keep the file lock alive.
 * @param {string} fileId The file ID to send the heartbeat for
 * @returns {Promise<{status:string, cache_status:{dirty:boolean, last_modified:number|null, last_checked:number|null}}>} The response from the server
 * @throws {Error} If the file ID is not provided or if the heartbeat fails
 */
async function sendHeartbeat(fileId) {
  if (!fileId) {
    throw new Error("File ID is required for heartbeat");
  }
  return await apiClient.filesHeartbeat({ file_id: fileId });
}

/**
 * Checks if a file is locked by another user.
 * @param {string} fileId The file ID to check the lock for
 * @returns {Promise<{is_locked: boolean}>} The response from the server indicating if the file is locked
 * @throws {Error} If the file ID is not provided or if the lock check fails
 */
async function checkLock(fileId) {
  if (!fileId) {
    throw new Error("File ID is required to check lock");
  }
  return await apiClient.filesCheckLock({ file_id: fileId });
}

/**
 * Acquires a lock on a file
 * @param {string} fileId
 * @returns {Promise<Object>}
 */
async function acquireLock(fileId) {
  if (!fileId) {
    throw new Error("File ID is required to acquire lock");
  }
  return await apiClient.filesAcquireLock({ file_id: fileId });
}

/**
 * Releases a lock on a file
 * @param {string} fileId
 * @returns {Promise<Object>}
 */
async function releaseLock(fileId) {
  if (!fileId) {
    throw new Error("File ID is required to release lock");
  }
  return await apiClient.filesReleaseLock({ file_id: fileId });
}


/**
 * Retrieves an object mapping all currently locked files to the session ID that locked them.
 * @returns {Promise<{[key:string]:Number}>} An object mapping locked file paths to session IDs
 */
async function getAllLockedFileIds() {
  return await apiClient.filesLocks();
}

/**
 * Gets the current file data cache status from the server.
 * @deprecated This endpoint is deprecated in FastAPI - database is always current
 * @returns {Promise<{dirty: boolean, last_modified: number|null, last_checked: number|null}>} Cache status object
 */
async function getCacheStatus() {
  // TODO: Remove this method - no longer exists in FastAPI (database is always current)
  return await callApi('/files/cache_status', 'GET');
}

/**
 * Uploads a file selected by the user to a specified URL using `fetch()`.
 *
 * @param {string} uploadUrl - The URL to which the file will be uploaded.
 * @param {object} [options={}] - Optional configuration options.
 * @param {string} [options.method='POST'] - The HTTP method to use for the upload.
 * @param {string} [options.fieldName='file'] - The name of the form field for the file.
 * @param {object} [options.headers={}] - Additional headers to include in the request.
 * @param {function} [options.onProgress] - A callback function to handle upload progress events.
 *    The function receives a progress event object as an argument.
 * @param {string} [options.accept='.pdf, .xml'] - The accepted file types for the file input.
 *    This is a string that will be set as the `accept` attribute of the file
 * @returns {Promise<{ type:string, filename:string, originalFilename:string } >} - A Promise that resolves with the json-deserialized result
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
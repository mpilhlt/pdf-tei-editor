/**
 * Auto-generated API client for PDF-TEI Editor API v1
 *
 * Generated from OpenAPI schema at 2025-10-05T18:23:15.758Z
 *
 * DO NOT EDIT MANUALLY - regenerate using: npm run generate-client
 */

// Type Definitions
/**
 * @typedef {Object} ConfigSetRequest
 * @property {string} key
 * @property {any} value
 */

/**
 * @typedef {Object} ConfigSetResponse
 * @property {string} result
 */

/**
 * @typedef {Object} HTTPValidationError
 * @property {Array<ValidationError>=} detail
 */

/**
 * @typedef {Object} InstructionItem
 * @property {string} label
 * @property {Array<string>} extractor
 * @property {Array<string>} text
 */

/**
 * @typedef {Object} LoginRequest
 * @property {string} username
 * @property {string} passwd_hash
 */

/**
 * @typedef {Object} LoginResponse
 * @property {string} username
 * @property {string=} fullname
 * @property {string=} role
 * @property {string} sessionId
 */

/**
 * @typedef {Object} LogoutResponse
 * @property {string} status
 */

/**
 * @typedef {Object} SaveInstructionsResponse
 * @property {string} result
 */

/**
 * @typedef {Object} StateResponse
 * @property {boolean} webdavEnabled
 * @property {boolean=} hasInternet
 */

/**
 * @typedef {Object} StatusResponse
 * @property {string} username
 * @property {string=} fullname
 * @property {string=} role
 */

/**
 * @typedef {Object} ValidationError
 * @property {Array<(string | number)>} loc
 * @property {string} msg
 * @property {string} type
 */

/**
 * API Client for FastAPI v1 endpoints
 *
 * This client wraps the callApi function to provide typed methods for all API endpoints.
 *
 * @example
 * const client = new ApiClientV1(callApi);
 * const { sessionId } = await client.authLogin({ username: 'admin', passwd_hash: '...' });
 */
export class ApiClientV1 {
  /**
   * Create a new API client
   * @param {Function} callApiFn - The callApi function from the application
   */
  constructor(callApiFn) {
    this.callApi = callApiFn;
  }

  /**
   * Authenticate user and create session.
   * Returns user data and session ID for client to store in state.
   *
   * @param {LoginRequest} requestBody
   * @returns {Promise<LoginResponse>}
   */
  async authLogin(requestBody) {
    const endpoint = `/auth/login`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Logout user by deleting their session.
   * Returns success even if no session exists.
   *
   * @returns {Promise<LogoutResponse>}
   */
  async authLogout() {
    const endpoint = `/auth/logout`
    return this.callApi(endpoint, 'POST');
  }

  /**
   * Check current user's authentication status.
   * Refreshes session access time if valid.
   *
   * @returns {Promise<StatusResponse>}
   */
  async authStatus() {
    const endpoint = `/auth/status`
    return this.callApi(endpoint);
  }

  /**
   * List all configuration values.
   * Returns complete configuration object.
   *
   * @returns {Promise<Object<string, any>>}
   */
  async configList() {
    const endpoint = `/config/list`
    return this.callApi(endpoint);
  }

  /**
   * Get a specific configuration value by key.
   * Returns the value associated with the key.
   *
   * @param {string} key
   * @returns {Promise<any>}
   */
  async configGet(key) {
    const endpoint = `/config/get/${key}`
    return this.callApi(endpoint);
  }

  /**
   * Set a configuration value.
   * Requires authentication.
   *
   * @param {ConfigSetRequest} requestBody
   * @returns {Promise<ConfigSetResponse>}
   */
  async configSet(requestBody) {
    const endpoint = `/config/set`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get extraction instructions.
   * Requires authentication.
   * Returns list of instruction items.
   *
   * @returns {Promise<Array<InstructionItem>>}
   */
  async configGetInstructions() {
    const endpoint = `/config/instructions`
    return this.callApi(endpoint);
  }

  /**
   * Save extraction instructions.
   * Requires authentication.
   *
   * @param {Array<InstructionItem>} requestBody
   * @returns {Promise<SaveInstructionsResponse>}
   */
  async configSaveInstructions(requestBody) {
    const endpoint = `/config/instructions`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get application state information.
   * Returns state including WebDAV status and internet connectivity.
   *
   * @returns {Promise<StateResponse>}
   */
  async configState() {
    const endpoint = `/config/state`
    return this.callApi(endpoint);
  }

}

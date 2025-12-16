/**
 * Auto-generated API client for PDF-TEI Editor API v1
 *
 * Generated from OpenAPI schema at 2025-12-16T07:34:02.367Z
 *
 * DO NOT EDIT MANUALLY - regenerate using: npm run generate-client
 */

// Type Definitions
/**
 * @typedef {Object} AcquireLockRequest
 * @property {string} file_id
 */

/**
 * @typedef {Object} AnalyzeRequest
 * @property {string} text
 */

/**
 * @typedef {Object} AnalyzeResponse
 * @property {number} word_count
 * @property {number} char_count
 * @property {string} message
 */

/**
 * @typedef {Object} ArtifactModel
 * @property {string} id
 * @property {string} filename
 * @property {string} file_type
 * @property {string} label
 * @property {number} file_size
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string=} variant
 * @property {number=} version
 * @property {boolean} is_gold_standard
 * @property {boolean} is_locked
 * @property {Object<string, any>=} access_control
 */

/**
 * @typedef {Object} AutocompleteDataRequest
 * @property {string} xml_string - XML document containing schema reference
 * @property {boolean=} invalidate_cache - Whether to invalidate cache and re-download schema
 */

/**
 * @typedef {Object} AutocompleteDataResponse
 * @property {Object<string, any>} data - CodeMirror autocomplete map with element definitions
 */

/**
 * @typedef {Object} Body_import_files_api_v1_import_post
 * @property {string} file - Zip archive containing files to import
 */

/**
 * @typedef {Object} Body_upload_file_api_v1_files_upload_post
 * @property {string} file
 */

/**
 * @typedef {Object} CheckLockRequest
 * @property {string} file_id
 */

/**
 * @typedef {Object} CheckLockResponse
 * @property {boolean} is_locked
 * @property {string=} locked_by
 */

/**
 * @typedef {Object} Collection
 * @property {string} id - Unique collection identifier
 * @property {string} name - Display name for the collection
 * @property {string=} description - Collection description
 */

/**
 * @typedef {Object} CollectionDeleteResponse
 * @property {boolean} success - Whether deletion was successful
 * @property {string} collection_id - ID of the deleted collection
 * @property {number} files_updated - Number of files updated (collection removed)
 * @property {number} files_deleted - Number of files marked as deleted
 */

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
 * @typedef {Object} ConflictInfo
 * @property {string} file_id
 * @property {string} stable_id
 * @property {string} filename
 * @property {string} doc_id
 * @property {string} local_modified_at
 * @property {string} local_hash
 * @property {string} remote_modified_at
 * @property {string} remote_hash
 * @property {string} conflict_type
 */

/**
 * @typedef {Object} ConflictListResponse
 * @property {Array<ConflictInfo>} conflicts
 * @property {number} total
 */

/**
 * @typedef {Object} ConflictResolution
 * @property {string} file_id
 * @property {string} resolution
 * @property {string=} new_variant - Variant name when using 'keep_both' resolution
 */

/**
 * @typedef {Object} CopyFilesRequest
 * @property {string} pdf_id
 * @property {string} xml_id
 * @property {string} destination_collection
 */

/**
 * @typedef {Object} CopyFilesResponse
 * @property {string} new_pdf_id
 * @property {string} new_xml_id
 */

/**
 * @typedef {Object} CreateGroupRequest
 * @property {string} id - Unique group identifier
 * @property {string} name - Group display name
 * @property {string=} description - Group description
 * @property {Array<string>=} collections - List of collection IDs
 */

/**
 * @typedef {Object} CreateRoleRequest
 * @property {string} id - Unique role identifier
 * @property {string} roleName - Role display name
 * @property {string=} description - Role description
 */

/**
 * @typedef {Object} CreateUserRequest
 * @property {string} username - Unique username
 * @property {string} passwd_hash - User password (will be hashed)
 * @property {string=} fullname - User's full name
 * @property {string=} email - User's email address
 * @property {Array<string>=} roles - List of user roles
 * @property {Array<string>=} groups - List of groups
 */

/**
 * @typedef {Object} DeleteFilesRequest
 * @property {Array<string>} files
 */

/**
 * @typedef {Object} DeleteFilesResponse
 * @property {string} result
 */

/**
 * @typedef {Object} DocumentGroupModel
 * @property {string} doc_id
 * @property {Array<string>} collections
 * @property {Object<string, any>} doc_metadata
 * @property {FileItemModel} source
 * @property {Array<ArtifactModel>} artifacts
 */

/**
 * @typedef {Object} ExecuteRequest
 * @property {string} endpoint
 * @property {Object<string, any>} params
 */

/**
 * @typedef {Object} ExecuteResponse
 * @property {boolean} success
 * @property {any} result
 */

/**
 * @typedef {Object} ExtractRequest
 * @property {string} extractor - ID of the extractor to use
 * @property {string} file_id - File identifier (hash, stable ID, or upload filename)
 * @property {Object<string, any>=} options - Extractor-specific options (e.g., doi, collection, variant_id)
 */

/**
 * @typedef {Object} ExtractResponse
 * @property {string=} id - Document ID (for PDF-based extractions)
 * @property {string=} pdf - PDF file hash (if applicable)
 * @property {string} xml - Extracted/generated XML file hash
 */

/**
 * @typedef {Object} ExtractorInfo
 * @property {string} id - Unique identifier for the extractor
 * @property {string} name - Human-readable name of the extractor
 * @property {string} description - Description of what the extractor does
 * @property {Array<string>} input - Supported input types (e.g., ['pdf'], ['xml'])
 * @property {Array<string>} output - Supported output types (e.g., ['xml'])
 * @property {boolean} available - Whether the extractor is currently available
 * @property {Object<string, any>=} options - Configuration options supported by the extractor
 */

/**
 * @typedef {Object} FileItemModel
 * @property {string} id
 * @property {string} filename
 * @property {string} file_type
 * @property {string} label
 * @property {number} file_size
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} FileListResponseModel
 * @property {Array<DocumentGroupModel>} files
 */

/**
 * @typedef {Object} GarbageCollectRequest
 * @property {string} deleted_before
 * @property {string=} sync_status
 */

/**
 * @typedef {Object} GarbageCollectResponse
 * @property {number} purged_count
 * @property {number} files_deleted
 * @property {number} storage_freed
 */

/**
 * @typedef {Object} GetLocksResponse
 * @property {Array<string>} locked_files
 */

/**
 * @typedef {Object} Group
 * @property {string} id - Unique group identifier
 * @property {string} name - Group display name
 * @property {string=} description - Group description
 * @property {Array<string>=} collections - List of collection IDs accessible to this group
 */

/**
 * @typedef {Object} HTTPValidationError
 * @property {Array<ValidationError>=} detail
 */

/**
 * @typedef {Object} HeartbeatRequest
 * @property {string} file_id
 */

/**
 * @typedef {Object} HeartbeatResponse
 * @property {string} status
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
 * @property {Array<string>=} roles
 * @property {string} sessionId
 */

/**
 * @typedef {Object} LogoutResponse
 * @property {string} status
 */

/**
 * @typedef {Object} MoveFilesRequest
 * @property {string} pdf_id
 * @property {string} xml_id
 * @property {string} destination_collection
 */

/**
 * @typedef {Object} MoveFilesResponse
 * @property {string} new_pdf_id
 * @property {string} new_xml_id
 */

/**
 * @typedef {Object} PluginListResponse
 * @property {Array<Object<string, any>>} plugins
 */

/**
 * @typedef {Object} ReleaseLockRequest
 * @property {string} file_id
 */

/**
 * @typedef {Object} ReleaseLockResponse
 * @property {string} action
 * @property {string} message
 */

/**
 * @typedef {Object} Role
 * @property {string} id - Unique role identifier
 * @property {string} roleName - Role display name
 * @property {string=} description - Role description
 */

/**
 * @typedef {Object} SaveFileRequest
 * @property {string} xml_string
 * @property {string} file_id
 * @property {boolean=} new_version
 * @property {string=} encoding
 */

/**
 * @typedef {Object} SaveFileResponse
 * @property {string} status
 * @property {string} file_id
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
 * @property {Array<string>=} roles
 */

/**
 * @typedef {Object} SyncRequest
 * @property {boolean=} force - Force sync even if quick check indicates no changes needed
 */

/**
 * @typedef {Object} SyncStatusResponse
 * @property {boolean} needs_sync
 * @property {number} local_version
 * @property {number} remote_version
 * @property {number} unsynced_count
 * @property {string=} last_sync_time
 * @property {boolean=} sync_in_progress
 */

/**
 * @typedef {Object} SyncSummary
 * @property {boolean=} skipped
 * @property {number=} uploaded
 * @property {number=} downloaded
 * @property {number=} deleted_local
 * @property {number=} deleted_remote
 * @property {number=} metadata_synced
 * @property {number=} conflicts
 * @property {number=} errors
 * @property {number=} new_version
 * @property {number=} duration_ms
 */

/**
 * @typedef {Object} UpdateGroupRequest
 * @property {string=} name - Group display name
 * @property {string=} description - Group description
 * @property {Array<string>=} collections - List of collection IDs
 */

/**
 * @typedef {Object} UpdateRoleRequest
 * @property {string=} roleName - Role display name
 * @property {string=} description - Role description
 */

/**
 * @typedef {Object} UpdateUserRequest
 * @property {string=} fullname - User's full name
 * @property {string=} email - User's email address
 * @property {string=} passwd_hash - New password (will be hashed)
 * @property {Array<string>=} roles - List of user roles
 * @property {Array<string>=} groups - List of groups
 */

/**
 * @typedef {Object} UploadResponse
 * @property {string} type
 * @property {string} filename
 */

/**
 * @typedef {Object} User
 * @property {string} username - Unique username
 * @property {string=} fullname - User's full name
 * @property {string=} email - User's email address
 * @property {Array<string>=} roles - List of user roles
 * @property {Array<string>=} groups - List of groups user belongs to
 * @property {string=} session_id - Current session ID
 */

/**
 * @typedef {Object} ValidateRequest
 * @property {string} xml_string - XML document to validate
 */

/**
 * @typedef {Object} ValidateResponse
 * @property {Array<ValidationErrorModel>=} errors - List of validation errors/warnings. Empty if validation passed.
 */

/**
 * @typedef {Object} ValidationError
 * @property {Array<(string | number)>} loc
 * @property {string} msg
 * @property {string} type
 */

/**
 * @typedef {Object} ValidationErrorModel
 * @property {string} message - Error or warning message
 * @property {number} line - Line number where error occurred
 * @property {number} column - Column number where error occurred
 * @property {string=} severity - Error severity (e.g., 'warning' for timeout messages)
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
  async configListInstructions() {
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

  /**
   * List all collections accessible to the current user.
   * Filters collections based on user's group memberships. Admin users and
   * users with wildcard access see all collections.
   * Returns:
   * List of Collection objects
   *
   * @returns {Promise<Array<Collection>>}
   */
  async listCollections() {
    const endpoint = `/collections`
    return this.callApi(endpoint);
  }

  /**
   * Create a new collection.
   * Args:
   * collection: Collection data
   * current_user: Current user dict (injected)
   * Returns:
   * Created Collection object
   * Raises:
   * HTTPException: 400 if validation fails or collection exists
   *
   * @param {Collection} requestBody
   * @returns {Promise<void>}
   */
  async createCollections(requestBody) {
    const endpoint = `/collections`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get a specific collection by ID.
   * Args:
   * collection_id: Collection identifier
   * current_user: Current user dict (injected)
   * Returns:
   * Collection object
   * Raises:
   * HTTPException: 404 if collection not found
   *
   * @param {string} collection_id
   * @returns {Promise<Collection>}
   */
  async getCollections(collection_id) {
    const endpoint = `/collections/${collection_id}`
    return this.callApi(endpoint);
  }

  /**
   * Update an existing collection.
   * Args:
   * collection_id: Collection identifier
   * collection: Updated collection data
   * current_user: Current user dict (injected)
   * Returns:
   * Updated Collection object
   * Raises:
   * HTTPException: 404 if collection not found, 400 if validation fails
   *
   * @param {string} collection_id
   * @param {Collection} requestBody
   * @returns {Promise<Collection>}
   */
  async updateCollections(collection_id, requestBody) {
    const endpoint = `/collections/${collection_id}`
    return this.callApi(endpoint, 'PUT', requestBody);
  }

  /**
   * Delete a collection and clean up file metadata.
   * For each file in the collection:
   * - Removes the collection from the file's collections list
   * - If the file has no other collections, marks it as deleted
   * Args:
   * collection_id: Collection identifier
   * current_user: Current user dict (injected)
   * Returns:
   * CollectionDeleteResponse with deletion statistics
   * Raises:
   * HTTPException: 404 if collection not found
   *
   * @param {string} collection_id
   * @returns {Promise<CollectionDeleteResponse>}
   */
  async deleteCollections(collection_id) {
    const endpoint = `/collections/${collection_id}`
    return this.callApi(endpoint, 'DELETE');
  }

  /**
   * List all users.
   * Requires authentication.
   * Returns:
   * List of User objects (passwords excluded)
   *
   * @returns {Promise<Array<User>>}
   */
  async listUsers() {
    const endpoint = `/users`
    return this.callApi(endpoint);
  }

  /**
   * Create a new user.
   * Requires admin role.
   * Returns:
   * Created user information (password excluded)
   *
   * @param {CreateUserRequest} requestBody
   * @returns {Promise<User>}
   */
  async createUsers(requestBody) {
    const endpoint = `/users`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get a specific user by username.
   * Requires authentication.
   * Returns:
   * User information (password excluded)
   *
   * @param {string} username
   * @returns {Promise<User>}
   */
  async getUsers(username) {
    const endpoint = `/users/${username}`
    return this.callApi(endpoint);
  }

  /**
   * Update an existing user.
   * Requires admin role.
   * Returns:
   * Updated user information (password excluded)
   *
   * @param {string} username
   * @param {UpdateUserRequest} requestBody
   * @returns {Promise<User>}
   */
  async updateUsers(username, requestBody) {
    const endpoint = `/users/${username}`
    return this.callApi(endpoint, 'PUT', requestBody);
  }

  /**
   * Delete a user.
   * Requires admin role.
   * Cannot delete yourself.
   * Returns:
   * Success message
   *
   * @param {string} username
   * @returns {Promise<any>}
   */
  async deleteUsers(username) {
    const endpoint = `/users/${username}`
    return this.callApi(endpoint, 'DELETE');
  }

  /**
   * List all groups.
   * Requires authentication.
   * Returns:
   * List of Group objects
   *
   * @returns {Promise<Array<Group>>}
   */
  async listGroups() {
    const endpoint = `/groups`
    return this.callApi(endpoint);
  }

  /**
   * Create a new group.
   * Requires admin role.
   * Returns:
   * Created group information
   *
   * @param {CreateGroupRequest} requestBody
   * @returns {Promise<Group>}
   */
  async createGroups(requestBody) {
    const endpoint = `/groups`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get a specific group by ID.
   * Requires authentication.
   * Returns:
   * Group information
   *
   * @param {string} group_id
   * @returns {Promise<Group>}
   */
  async getGroups(group_id) {
    const endpoint = `/groups/${group_id}`
    return this.callApi(endpoint);
  }

  /**
   * Update an existing group.
   * Requires admin role.
   * Returns:
   * Updated group information
   *
   * @param {string} group_id
   * @param {UpdateGroupRequest} requestBody
   * @returns {Promise<Group>}
   */
  async updateGroups(group_id, requestBody) {
    const endpoint = `/groups/${group_id}`
    return this.callApi(endpoint, 'PUT', requestBody);
  }

  /**
   * Delete a group.
   * Requires admin role.
   * Returns:
   * Success message
   *
   * @param {string} group_id
   * @returns {Promise<any>}
   */
  async deleteGroups(group_id) {
    const endpoint = `/groups/${group_id}`
    return this.callApi(endpoint, 'DELETE');
  }

  /**
   * List all roles.
   * Requires authentication.
   * Returns:
   * List of Role objects
   *
   * @returns {Promise<Array<Role>>}
   */
  async listRoles() {
    const endpoint = `/roles`
    return this.callApi(endpoint);
  }

  /**
   * Create a new role.
   * Requires admin role.
   * Returns:
   * Created role information
   *
   * @param {CreateRoleRequest} requestBody
   * @returns {Promise<Role>}
   */
  async createRoles(requestBody) {
    const endpoint = `/roles`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get a specific role by ID.
   * Requires authentication.
   * Returns:
   * Role information
   *
   * @param {string} role_id
   * @returns {Promise<Role>}
   */
  async getRoles(role_id) {
    const endpoint = `/roles/${role_id}`
    return this.callApi(endpoint);
  }

  /**
   * Update an existing role.
   * Requires admin role.
   * Returns:
   * Updated role information
   *
   * @param {string} role_id
   * @param {UpdateRoleRequest} requestBody
   * @returns {Promise<Role>}
   */
  async updateRoles(role_id, requestBody) {
    const endpoint = `/roles/${role_id}`
    return this.callApi(endpoint, 'PUT', requestBody);
  }

  /**
   * Delete a role.
   * Requires admin role.
   * Cannot delete built-in roles (admin, user, reviewer, annotator).
   * Returns:
   * Success message
   *
   * @param {string} role_id
   * @returns {Promise<any>}
   */
  async deleteRoles(role_id) {
    const endpoint = `/roles/${role_id}`
    return this.callApi(endpoint, 'DELETE');
  }

  /**
   * Validate XML document against embedded schema references.
   * Supports both XSD (xsi:schemaLocation) and RelaxNG (xml-model) schemas.
   * Automatically downloads and caches schemas on first use.
   * Uses subprocess isolation for timeout protection on complex schemas.
   * Returns:
   * List of validation errors. Empty list if validation passed.
   *
   * @param {ValidateRequest} requestBody
   * @returns {Promise<ValidateResponse>}
   */
  async validate(requestBody) {
    const endpoint = `/validate`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Generate CodeMirror autocomplete data from the schema associated with an XML document.
   * Only supports RelaxNG schemas. The schema is extracted from the XML document's
   * schema reference (xml-model processing instruction or xsi:schemaLocation).
   * If invalidate_cache is True, requires internet connectivity to re-download the schema.
   * Returns:
   * JSON autocomplete data suitable for CodeMirror XML mode.
   *
   * @param {AutocompleteDataRequest} requestBody
   * @returns {Promise<AutocompleteDataResponse>}
   */
  async validateAutocompleteData(requestBody) {
    const endpoint = `/validate/autocomplete-data`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * List all available extractors with their capabilities.
   * Returns only extractors that are currently available (dependencies satisfied).
   * Returns:
   * List of extractor information including input/output types and availability
   *
   * @returns {Promise<Array<ExtractorInfo>>}
   */
  async extractList() {
    const endpoint = `/extract/list`
    return this.callApi(endpoint);
  }

  /**
   * Perform metadata extraction using the specified extractor.
   * Supports:
   * - PDF-based extraction (e.g., Grobid, Gemini)
   * - XML-based extraction (e.g., metadata refiners)
   * - RNG schema generation from XML
   * The extracted content is saved as a new file with appropriate metadata.
   * Args:
   * request: Extraction request with extractor ID, file ID, and options
   * repo: File repository (injected)
   * storage: File storage (injected)
   * current_user: Authenticated user (injected)
   * settings: Application settings (injected)
   * Returns:
   * Response with PDF hash (if applicable) and extracted XML hash
   *
   * @param {ExtractRequest} requestBody
   * @returns {Promise<ExtractResponse>}
   */
  async extract(requestBody) {
    const endpoint = `/extract`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * List all files grouped by document.
   * Returns files in simplified document-centric structure:
   * - One entry per document (doc_id)
   * - Source file (PDF or primary XML) + flattened artifacts array
   * - Lock information for each file
   * - Access control filtering applied
   * - Stable IDs throughout
   * Note: 'refresh' parameter ignored - database is always current.
   * Args:
   * variant: Optional variant filter (e.g., "grobid")
   * refresh: Deprecated parameter (ignored)
   * repo: File repository (injected)
   * session_id: Current session ID (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * FileListResponseModel with files property containing List of DocumentGroupModel objects
   *
   * @param {Object=} params - Query parameters
   * @param {(string | null)=} params.variant
   * @param {boolean=} params.refresh
   * @returns {Promise<FileListResponseModel>}
   */
  async filesList(params) {
    const endpoint = `/files/list`
    return this.callApi(endpoint, 'GET', params);
  }

  /**
   * Save TEI XML file with version management.
   * Simplified logic compared to Flask:
   * 1. Extract file_id and variant from XML
   * 2. Query database for existing file
   * 3. Determine save strategy (update, new version, new gold)
   * 4. Save to hash-sharded storage
   * 5. Update database with metadata
   * Role-based access:
   * - Reviewers can edit gold files
   * - Annotators can create versions
   * - Reviewers can promote versions to gold
   *
   * @param {SaveFileRequest} requestBody
   * @returns {Promise<SaveFileResponse>}
   */
  async filesSave(requestBody) {
    const endpoint = `/files/save`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Create a new version from an uploaded temp file.
   * Note: This endpoint requires temp file upload mechanism to be implemented.
   * Currently deferred as upload handling needs to be designed.
   *
   * @param {Object<string, any>} requestBody
   * @returns {Promise<SaveFileResponse>}
   */
  async filesCreateVersionFromUpload(requestBody) {
    const endpoint = `/files/create_version_from_upload`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Delete files (soft delete with reference counting).
   * Sets deleted=1 and sync_status='pending_delete' in database.
   * Reference counting ensures physical files are deleted only when:
   * - No database entries reference the file (ref_count = 0)
   * - Safe for deduplication (same content shared by multiple entries)
   * Args:
   * body: DeleteFilesRequest with list of file IDs (stable_id or full hash)
   * repo: File repository (injected)
   * storage: File storage with reference counting (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * {"result": "ok"}
   * Raises:
   * HTTPException: 403 if insufficient permissions
   *
   * @param {DeleteFilesRequest} requestBody
   * @returns {Promise<DeleteFilesResponse>}
   */
  async filesDelete(requestBody) {
    const endpoint = `/files/delete`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Garbage collect soft-deleted files older than the specified timestamp.
   * Permanently removes files that have been soft-deleted and meet all filter criteria:
   * - deleted=1 (soft-deleted)
   * - updated_at < deleted_before timestamp
   * - sync_status matches (if provided)
   * Filters are additive - all conditions must match if they have a value.
   * Security:
   * - Admin role required for timestamps younger than 24 hours (prevents accidental deletion)
   * - All users can garbage collect files older than 24 hours
   * This operation:
   * 1. Finds all deleted files matching the criteria
   * 2. Removes physical files from storage
   * 3. Permanently deletes database records
   * 4. Returns statistics about purged files
   * Args:
   * body: GarbageCollectRequest with timestamp and optional filters
   * repo: File repository (injected)
   * storage: File storage (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * GarbageCollectResponse with purge statistics
   * Raises:
   * HTTPException: 403 if non-admin user tries to purge files deleted within 24 hours
   *
   * @param {GarbageCollectRequest} requestBody
   * @returns {Promise<GarbageCollectResponse>}
   */
  async filesGarbageCollect(requestBody) {
    const endpoint = `/files/garbage_collect`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Move files to a different collection.
   * In the multi-collection system, this adds the destination collection
   * to the document's doc_collections array in the PDF file.
   * No physical file move occurs - hash-sharded storage is collection-agnostic.
   * TEI files inherit collections from their associated PDF.
   * Args:
   * request: MoveFilesRequest with pdf_path, xml_path, and destination_collection
   * repo: File repository (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * MoveFilesResponse with new paths (same as input in hash-based system)
   * Raises:
   * HTTPException: 403 if insufficient permissions, 404 if file not found
   *
   * @param {MoveFilesRequest} requestBody
   * @returns {Promise<MoveFilesResponse>}
   */
  async filesMove(requestBody) {
    const endpoint = `/files/move`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Copy files to an additional collection.
   * In the multi-collection system, this adds the destination collection
   * to the document's doc_collections array while keeping existing collections.
   * No physical file copy occurs - hash-sharded storage is collection-agnostic.
   * TEI files inherit collections from their associated PDF.
   * Args:
   * body: CopyFilesRequest with pdf_path, xml_path, and destination_collection
   * repo: File repository (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * CopyFilesResponse with paths (same as input in hash-based system)
   * Raises:
   * HTTPException: 403 if insufficient permissions, 404 if file not found
   *
   * @param {CopyFilesRequest} requestBody
   * @returns {Promise<CopyFilesResponse>}
   */
  async filesCopy(requestBody) {
    const endpoint = `/files/copy`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Get all active locks for the current session.
   * Returns a list of file stable_ids locked by this session.
   * Args:
   * repo: File repository (injected)
   * session_id: Current session ID (injected)
   * Returns:
   * GetLocksResponse: List of file stable_ids locked by this session
   *
   * @returns {Promise<GetLocksResponse>}
   */
  async filesLocks() {
    const endpoint = `/files/locks`
    return this.callApi(endpoint);
  }

  /**
   * Check if a file is locked.
   * Args:
   * request: CheckLockRequest with file_id (stable_id or full hash)
   * repo: File repository (injected)
   * session_id: Current session ID (injected)
   * Returns:
   * CheckLockResponse with is_locked and locked_by fields
   *
   * @param {CheckLockRequest} requestBody
   * @returns {Promise<CheckLockResponse>}
   */
  async filesCheckLock(requestBody) {
    const endpoint = `/files/check_lock`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Acquire a lock for editing.
   * Args:
   * request: AcquireLockRequest with file_id (stable_id or full hash)
   * repo: File repository (injected)
   * session_id: Current session ID (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * "OK" string on success (matches Flask API)
   * Raises:
   * HTTPException: 403 if insufficient permissions, 404 if file not found, 423 if cannot acquire lock
   *
   * @param {AcquireLockRequest} requestBody
   * @returns {Promise<string>}
   */
  async filesAcquireLock(requestBody) {
    const endpoint = `/files/acquire_lock`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Release a lock.
   * Args:
   * request: ReleaseLockRequest with file_id (stable_id or full hash)
   * repo: File repository (injected)
   * session_id: Current session ID (injected)
   * Returns:
   * ReleaseLockResponse with action and message
   * Raises:
   * HTTPException: 409 if failed to release lock
   *
   * @param {ReleaseLockRequest} requestBody
   * @returns {Promise<ReleaseLockResponse>}
   */
  async filesReleaseLock(requestBody) {
    const endpoint = `/files/release_lock`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Refresh file lock (keep-alive).
   * The existing acquire_lock function already handles refreshing
   * a lock if it's owned by the same session.
   * Note: No cache_status in FastAPI (deprecated - database is always current).
   * Args:
   * request: HeartbeatRequest with file_id (stable_id or full hash)
   * repo: File repository (injected)
   * session_id: Current session ID (injected)
   * Returns:
   * HeartbeatResponse with status='lock_refreshed'
   * Raises:
   * HTTPException: 409 if failed to refresh lock
   *
   * @param {HeartbeatRequest} requestBody
   * @returns {Promise<HeartbeatResponse>}
   */
  async filesHeartbeat(requestBody) {
    const endpoint = `/files/heartbeat`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Export files as a downloadable zip archive.
   * Requires valid session authentication. Exports files filtered by:
   * - Collections: If specified, only those collections (filtered by user access)
   * - Variants: Optional variant filtering with glob pattern support
   * - User access control: Only collections user has access to
   * Args:
   * collections: Comma-separated collection names (optional)
   * variants: Comma-separated variant names (optional)
   * include_versions: Include versioned TEI files (default: False)
   * group_by: Directory grouping: "type", "collection", or "variant"
   * db: Database manager (injected)
   * repo: File repository (injected)
   * storage: File storage (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * FileResponse with zip archive for download
   *
   * @param {Object=} params - Query parameters
   * @param {(string | null)=} params.collections
   * @param {(string | null)=} params.variants
   * @param {boolean=} params.include_versions
   * @param {string=} params.group_by
   * @returns {Promise<any>}
   */
  async export(params) {
    const endpoint = `/export`
    return this.callApi(endpoint, 'GET', params);
  }

  /**
   * Check if synchronization is needed (O(1) operation).
   * Performs quick checks:
   * - Count of unsynced files in local database
   * - Local vs remote version comparison
   * Returns:
   * Sync status with version info and unsynced count
   *
   * @returns {Promise<SyncStatusResponse>}
   */
  async syncStatus() {
    const endpoint = `/sync/status`
    return this.callApi(endpoint);
  }

  /**
   * Perform database-driven synchronization.
   * Process:
   * 1. Quick skip check (unless force=true)
   * 2. Acquire remote lock
   * 3. Download remote metadata.db
   * 4. Compare metadata (find changes)
   * 5. Sync deletions (via database flags)
   * 6. Sync data files (upload/download)
   * 7. Sync metadata changes (no file transfers)
   * 8. Upload updated metadata.db
   * 9. Release lock
   * Progress updates are sent via SSE to the user's session.
   * Args:
   * request: Sync request with force flag
   * Returns:
   * Summary of sync operations performed
   *
   * @param {SyncRequest} requestBody
   * @returns {Promise<SyncSummary>}
   */
  async sync(requestBody) {
    const endpoint = `/sync`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * List files with sync conflicts.
   * Conflicts occur when:
   * - File modified locally and remotely
   * - File deleted remotely but modified locally
   * - File deleted locally but modified remotely
   * Returns:
   * List of conflicts with details
   *
   * @returns {Promise<ConflictListResponse>}
   */
  async syncConflicts() {
    const endpoint = `/sync/conflicts`
    return this.callApi(endpoint);
  }

  /**
   * Resolve a sync conflict.
   * Strategies:
   * - local_wins: Keep local version, mark as modified for upload
   * - remote_wins: Download remote version, overwrite local
   * - keep_both: Create new variant with local version
   * Args:
   * resolution: Conflict resolution request
   * Returns:
   * Success message
   *
   * @param {ConflictResolution} requestBody
   * @returns {Promise<Object<string, any>>}
   */
  async syncResolveConflict(requestBody) {
    const endpoint = `/sync/resolve-conflict`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Subscribe to Server-Sent Events stream.
   * Establishes a long-lived HTTP connection for receiving real-time updates.
   * Client should connect before initiating sync operations.
   * The stream sends events in SSE format:
   * ```
   * event: syncProgress
   * data: 42
   * event: syncMessage
   * data: Downloading files...
   * ```
   * Example event types:
   * - connected: Initial connection confirmation
   * - syncProgress: Progress percentage (0-100)
   * - syncMessage: Status message
   * - syncComplete: Sync finished successfully
   * - syncError: Sync error occurred
   * Returns:
   * StreamingResponse with text/event-stream content type
   *
   * @returns {Promise<any>}
   */
  async sseSubscribe() {
    const endpoint = `/sse/subscribe`
    return this.callApi(endpoint);
  }

  /**
   * Test endpoint that echoes a list of messages as SSE events.
   * This endpoint is used for testing SSE functionality. It sends each message
   * in the provided list as a separate SSE event to the client.
   * Args:
   * messages: List of strings to echo as SSE messages
   * Returns:
   * dict: Summary of messages sent
   * Note:
   * Client must be subscribed to /sse/subscribe before calling this endpoint.
   * Messages are sent to the session's SSE queue (based on session_id).
   *
   * @param {Array<string>} requestBody
   * @returns {Promise<any>}
   */
  async sseTestEcho(requestBody) {
    const endpoint = `/sse/test/echo`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Serve schema by type and variant name.
   * Provides clean, stable URLs for schema validation:
   * - /api/v1/schema/rng/grobid
   * - /api/v1/schema/xsd/myschema
   * Args:
   * schema_type: Schema type (e.g., 'rng', 'xsd')
   * variant: Variant name (e.g., 'grobid', 'gemini')
   * repo: File repository (injected)
   * storage: File storage (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * FileResponse with schema XML content
   * Raises:
   * HTTPException: 404 if schema not found, 403 if access denied
   *
   * @param {string} schema_type
   * @param {string} variant
   * @returns {Promise<any>}
   */
  async schema(schema_type, variant) {
    const endpoint = `/schema/${schema_type}/${variant}`
    return this.callApi(endpoint);
  }

  /**
   * List available plugins filtered by user roles and optional category.
   * Args:
   * category: Optional category filter (e.g., "analyzer")
   * current_user: Current authenticated user (optional)
   * Returns:
   * List of plugin metadata dicts
   *
   * @param {Object=} params - Query parameters
   * @param {(string | null)=} params.category
   * @returns {Promise<PluginListResponse>}
   */
  async plugins(params) {
    const endpoint = `/plugins`
    return this.callApi(endpoint, 'GET', params);
  }

  /**
   * Execute a plugin endpoint.
   * Args:
   * plugin_id: Plugin identifier
   * request: Execution request with endpoint and params
   * current_user: Current authenticated user (optional)
   * Returns:
   * Execution result
   * Raises:
   * HTTPException: If plugin/endpoint not found or execution fails
   *
   * @param {string} plugin_id
   * @param {ExecuteRequest} requestBody
   * @returns {Promise<ExecuteResponse>}
   */
  async pluginsExecute(plugin_id, requestBody) {
    const endpoint = `/plugins/${plugin_id}/execute`
    return this.callApi(endpoint, 'POST', requestBody);
  }

  /**
   * Serve file content by document identifier (stable_id or full hash).
   * Returns the actual file content with appropriate MIME type.
   * Access control is enforced.
   * Args:
   * document_id: stable_id or full hash (64 chars)
   * repo: File repository (injected)
   * storage: File storage (injected)
   * current_user: Current user dict (injected)
   * Returns:
   * FileResponse with file content
   * Raises:
   * HTTPException: 404 if file not found, 403 if access denied
   *
   * @param {string} document_id
   * @returns {Promise<any>}
   */
  async files(document_id) {
    const endpoint = `/files/${document_id}`
    return this.callApi(endpoint);
  }

}

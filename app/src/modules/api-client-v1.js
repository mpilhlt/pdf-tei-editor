/**
 * Auto-generated API client for PDF-TEI Editor API v1
 *
 * Generated from OpenAPI schema at 2025-10-28T21:46:28.619Z
 *
 * DO NOT EDIT MANUALLY - regenerate using: npm run generate-client
 */

// Type Definitions
/**
 * @typedef {Object} AcquireLockRequest
 * @property {string} file_id
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
 * @typedef {Object} GetLocksResponse
 * @property {Array<string>} locked_files
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
 * @typedef {Object} ReleaseLockRequest
 * @property {string} file_id
 */

/**
 * @typedef {Object} ReleaseLockResponse
 * @property {string} action
 * @property {string} message
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
 * @property {string} hash
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
 * @typedef {Object} UploadResponse
 * @property {string} type
 * @property {string} filename
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

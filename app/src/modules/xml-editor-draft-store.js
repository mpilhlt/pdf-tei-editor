/**
 * Draft persistence for the XML editor.
 *
 * Drafts are written to `localStorage` on every editor update so that users never
 * lose work when:
 *   - The editor holds malformed XML and auto-save is blocked.
 *   - The network or server is unavailable when auto-save attempts to write.
 *   - The browser tab is closed or refreshed before a save completes.
 *
 * Key scheme: `xmleditor.draft.<stableId>`
 * Value: JSON-encoded {@link DraftRecord}.
 *
 * Writes are best-effort: quota or serialization errors are logged but never thrown
 * so that a draft write failure cannot break editing.
 */

/**
 * @typedef {object} DraftRecord
 * @property {string} stableId - The stable id of the document the draft belongs to.
 * @property {string} content - Raw editor text (may be malformed XML).
 * @property {number} savedAt - Unix timestamp (ms) when the draft was written.
 * @property {number} documentVersion - Editor's document version at save time.
 * @property {boolean} wellFormed - Whether the content parsed as well-formed XML.
 */

/**
 * @typedef {object} Logger
 * @property {(message: any) => void} debug
 * @property {(message: any) => void} warn
 * @property {(message: any) => void} error
 */

const KEY_PREFIX = 'xmleditor.draft.';

/**
 * Maximum serialized draft length to attempt writing. `localStorage` quotas are
 * typically 5-10 MB per origin; we cap at ~2 MB to leave headroom for other
 * persisted state. If a document exceeds this, the draft is skipped with a warning.
 */
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

export class XmlEditorDraftStore {
  /** @type {Logger} */
  #logger;

  /** @type {Storage} */
  #storage;

  /**
   * @param {object} [options]
   * @param {Logger} [options.logger] - Defaults to console.
   * @param {Storage} [options.storage] - Defaults to window.localStorage.
   */
  constructor({ logger, storage } = {}) {
    this.#logger = logger ?? /** @type {Logger} */ (/** @type {unknown} */ (console));
    this.#storage = storage ?? window.localStorage;
  }

  /**
   * @param {string} stableId
   * @returns {string}
   */
  #key(stableId) {
    return `${KEY_PREFIX}${stableId}`;
  }

  /**
   * Persist a draft for the given document. Failures are logged, never thrown.
   *
   * @param {string} stableId
   * @param {string} content - Raw editor text.
   * @param {number} documentVersion - Current XMLEditor document version.
   * @param {boolean} wellFormed - Whether the content currently parses as well-formed XML.
   * @returns {boolean} True if the draft was written, false if skipped/failed.
   */
  saveDraft(stableId, content, documentVersion, wellFormed) {
    if (!stableId) {
      return false;
    }
    if (typeof content !== 'string') {
      return false;
    }
    if (content.length > MAX_DRAFT_BYTES) {
      this.#logger.warn(
        `XmlEditorDraftStore: draft for ${stableId} exceeds ${MAX_DRAFT_BYTES} bytes (${content.length}); skipping persistence.`
      );
      return false;
    }
    /** @type {DraftRecord} */
    const record = {
      stableId,
      content,
      savedAt: Date.now(),
      documentVersion,
      wellFormed: Boolean(wellFormed)
    };
    try {
      this.#storage.setItem(this.#key(stableId), JSON.stringify(record));
      return true;
    } catch (error) {
      // QuotaExceededError, security errors in private mode, etc.
      this.#logger.warn(`XmlEditorDraftStore: saveDraft failed for ${stableId}: ${String(error)}`);
      return false;
    }
  }

  /**
   * Load a draft for the given document.
   *
   * @param {string} stableId
   * @returns {DraftRecord | null} Parsed draft, or null if none exists or the record is invalid.
   */
  loadDraft(stableId) {
    if (!stableId) {
      return null;
    }
    let raw;
    try {
      raw = this.#storage.getItem(this.#key(stableId));
    } catch (error) {
      this.#logger.warn(`XmlEditorDraftStore: loadDraft read failed for ${stableId}: ${String(error)}`);
      return null;
    }
    if (!raw) {
      return null;
    }
    try {
      const parsed = /** @type {DraftRecord} */ (JSON.parse(raw));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.content !== 'string') {
        return null;
      }
      return parsed;
    } catch (error) {
      this.#logger.warn(`XmlEditorDraftStore: loadDraft parse failed for ${stableId}: ${String(error)}`);
      // Corrupt record - remove it.
      this.clearDraft(stableId);
      return null;
    }
  }

  /**
   * Returns true if a draft exists for the given document.
   * @param {string} stableId
   * @returns {boolean}
   */
  hasDraft(stableId) {
    return this.loadDraft(stableId) !== null;
  }

  /**
   * Remove the draft for the given document. No-op if none exists.
   * @param {string} stableId
   */
  clearDraft(stableId) {
    if (!stableId) {
      return;
    }
    try {
      this.#storage.removeItem(this.#key(stableId));
    } catch (error) {
      this.#logger.warn(`XmlEditorDraftStore: clearDraft failed for ${stableId}: ${String(error)}`);
    }
  }

  /**
   * List all draft stable-ids currently stored.
   * @returns {string[]}
   */
  listDraftIds() {
    const ids = [];
    try {
      for (let i = 0; i < this.#storage.length; i++) {
        const key = this.#storage.key(i);
        if (key && key.startsWith(KEY_PREFIX)) {
          ids.push(key.slice(KEY_PREFIX.length));
        }
      }
    } catch (error) {
      this.#logger.warn(`XmlEditorDraftStore: listDraftIds failed: ${String(error)}`);
    }
    return ids;
  }
}

export default XmlEditorDraftStore;

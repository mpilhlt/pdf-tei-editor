/**
 * @registerModule
 */

/**
 * Display of LLM review findings (proposed text replacements) as diagnostics in the XML editor.
 *
 * Shared by frontend extensions (which cannot use ES imports and reach it via
 * `getDependency('llm-findings')`) such as annotation-review and the OCR review. Findings are
 * anchored on their quoted text, not on positions, and are cached per document in session storage.
 * {@link FindingsDisplay} receives accessors for the xmleditor API and lint-utils instead of
 * importing plugins, so it can be used from extensions.
 *
 * @import { FixableDiagnostic } from './lint-utils.js'
 */

/** Format version of the cached review entries; entries of other versions are ignored. */
export const CACHE_VERSION = 1;

/**
 * @typedef {{id: number, old: string, new: string, rationale: string}} Finding
 */

/**
 * Locate the single occurrence of `finding.old` in the current document text.
 * Returns null when it is absent or ambiguous - the document may have changed
 * since the review request was sent, and such findings are dropped silently.
 * @param {Finding} finding
 * @param {string} docText
 * @returns {{from: number, to: number}|null}
 */
export function locateFinding(finding, docText) {
  const from = docText.indexOf(finding.old);
  if (from === -1 || docText.indexOf(finding.old, from + 1) !== -1) return null;
  return { from, to: from + finding.old.length };
}

/**
 * Build the document text with only this finding applied, for the merge view.
 * Returns null if the text at [from, to) is no longer exactly `finding.old`.
 * @param {string} docText
 * @param {number} from
 * @param {number} to
 * @param {Finding} finding
 * @returns {string|null}
 */
export function buildModifiedText(docText, from, to, finding) {
  if (docText.slice(from, to) !== finding.old) return null;
  return docText.slice(0, from) + finding.new + docText.slice(to);
}

/**
 * Turn findings into CodeMirror diagnostics positioned in the current text.
 * @param {Finding[]} findings
 * @param {string} docText
 * @param {(finding: Finding, from: number, to: number) => void} onProposeFix
 * @returns {FixableDiagnostic[]}
 */
export function findingsToDiagnostics(findings, docText, onProposeFix) {
  /** @type {FixableDiagnostic[]} */
  const diagnostics = [];
  for (const finding of findings) {
    const range = locateFinding(finding, docText);
    if (!range) continue;
    diagnostics.push({
      from: range.from,
      to: range.to,
      severity: 'info',
      message: finding.rationale,
      replacement: finding.new,
      actions: [{
        name: 'Propose fix',
        apply: (_view, from, to) => onProposeFix(finding, from, to),
      }],
    });
  }
  return diagnostics;
}

/**
 * The storage interface of `SessionStorage` (app/src/modules/session-storage.js)
 * used by {@link FindingsCache}.
 * @typedef {object} ContextStorage
 * @property {(contextId: string, key: string, defaultValue?: any) => any} getValue
 * @property {(contextId: string, updates: Record<string, any>) => void} setState
 * @property {(contextId: string) => void} clearState
 */

/**
 * A cached review of one document.
 * @typedef {object} CachedReview
 * @property {number} version - {@link CACHE_VERSION}
 * @property {Finding[]} findings
 */

/**
 * Keeps the findings of the current editing session per document in session
 * storage, so that reloading the page does not require a new (expensive)
 * review. Session storage is per browser tab and cleared when it is closed.
 * Findings are anchored on their quoted text, not on positions; the caller
 * re-locates them in the loaded document and drops those that no longer occur
 * exactly once, so cached findings cannot go stale.
 */
export class FindingsCache {
  /**
   * @param {ContextStorage} storage
   */
  constructor(storage) {
    this._storage = storage;
  }

  /**
   * The cached findings of the document, or [] if none (or of another format version).
   * @param {string} docId
   * @returns {Finding[]}
   */
  load(docId) {
    /** @type {CachedReview|undefined} */
    const entry = this._storage.getValue(docId, 'review');
    return entry?.version === CACHE_VERSION && Array.isArray(entry.findings) ? entry.findings : [];
  }

  /**
   * Stores the findings of the document, or removes its entry if there are none.
   * @param {string} docId
   * @param {Finding[]} findings
   * @returns {void}
   */
  save(docId, findings) {
    if (!findings.length) {
      this._storage.clearState(docId);
      return;
    }
    /** @type {CachedReview} */
    const review = { version: CACHE_VERSION, findings };
    this._storage.setState(docId, { review });
  }
}

/**
 * The subset of the xmleditor plugin API used by {@link FindingsDisplay}.
 * @typedef {object} FindingsEditorApi
 * @property {() => {state: {doc: {toString: () => string}}}} getView
 * @property {(listener: (update: any) => void) => void} addUpdateListener
 * @property {(event: string, listener: (...args: any[]) => void) => void} on
 */

/**
 * The subset of the lint-utils module used by {@link FindingsDisplay}.
 * @typedef {object} FindingsLintUtils
 * @property {(update: any) => boolean} replacesDiagnostics
 * @property {(view: any, source: string, own: FixableDiagnostic[], options?: {openPanel?: boolean}) => void} applyMergedDiagnostics
 * @property {(listener: (dismissed: FixableDiagnostic[]) => void) => void} addDismissListener
 */

/**
 * Holds the findings of one review, shows them as diagnostics merged into the editor's diagnostic
 * set, keeps them in the session cache of the current document and drops them when they no longer
 * apply.
 */
export class FindingsDisplay {
  /**
   * @param {object} options
   * @param {string} options.source - Diagnostic source tag identifying the owner's diagnostics
   * @param {() => FindingsEditorApi} options.getXmleditor - Accessor of the xmleditor API
   * @param {() => FindingsLintUtils} options.getLintUtils - Accessor of the lint-utils module
   * @param {ContextStorage} options.sessionStorage - A `SessionStorage` instance (session-storage module)
   * @param {(finding: Finding, from: number, to: number) => void} options.proposeFix - Called when the user proposes a fix
   * @param {() => string|null} [options.getDocId] - Stable id of the open document, used when the
   *   editor content is loaded later (`editorAfterLoad`)
   */
  constructor({ source, getXmleditor, getLintUtils, sessionStorage, proposeFix, getDocId = () => null }) {
    this._source = source;
    this._getXmleditor = getXmleditor;
    this._getLintUtils = getLintUtils;
    this._proposeFix = proposeFix;
    this._getDocId = getDocId;
    this._cache = new FindingsCache(sessionStorage);
    /** @type {Finding[]} */
    this._findings = [];
    /** @type {string|null} Stable id of the document the findings belong to; null while none is loaded. */
    this._docId = null;
    /** @type {boolean} True while this display dispatches its own diagnostics. */
    this._rendering = false;
    /** @type {number} Debounce (ms) before dropping findings whose text was edited away. */
    this._pruneDelayMs = 300;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this._pruneTimer = undefined;
  }

  /**
   * The current findings.
   * @returns {Finding[]}
   */
  get findings() {
    return this._findings;
  }

  /**
   * Register the editor update listener (re-merge after other sources replace the diagnostics,
   * prune after edits), the `editorAfterLoad` restore and the dismiss listener.
   * Does not restore the cached findings itself: callers must call {@link FindingsDisplay#restore}
   * with the id of the open document afterwards.
   * @returns {void}
   */
  attach() {
    const xmleditor = this._getXmleditor();
    const lintUtils = this._getLintUtils();
    xmleditor.addUpdateListener(update => {
      if (lintUtils.replacesDiagnostics(update) && !this._rendering && this._findings.length) {
        // CodeMirror forbids dispatching from inside an update listener
        setTimeout(() => this._renderFindings(false), 0);
      } else if (update.docChanged && !this._rendering && this._findings.length) {
        clearTimeout(this._pruneTimer);
        this._pruneTimer = setTimeout(() => this._pruneFindings(), this._pruneDelayMs);
      }
    });
    // the editor content is usually loaded before the document id is known; this covers content loaded later
    xmleditor.on('editorAfterLoad', () => this.restore(this._getDocId()));
    lintUtils.addDismissListener(dismissed => this._forgetDismissed(dismissed));
  }

  /**
   * Replace the findings and store them in the session cache of the current document.
   * @param {Finding[]} findings
   * @returns {void}
   */
  _setFindings(findings) {
    this._findings = findings;
    if (this._docId) this._cache.save(this._docId, findings);
  }

  /**
   * Make the document the one the findings are stored for and show its cached findings, e.g.
   * after a page reload, keeping only those whose quoted text still occurs exactly once.
   * Does nothing without an id, for the current document or while the editor is empty.
   * @param {string|null} docId - Stable id of the loaded document
   * @returns {void}
   */
  restore(docId) {
    if (!docId || docId === this._docId) return;
    const docText = this._getXmleditor().getView().state.doc.toString();
    // not loaded yet: editorAfterLoad calls again
    if (!docText) return;
    this._docId = docId;
    const cached = this._cache.load(docId);
    if (!cached.length) return;
    this._findings = cached.filter(f => locateFinding(f, docText) !== null);
    // reveal them, as after the review that produced them
    this._renderFindings(this._findings.length > 0);
  }

  /**
   * A different document is being loaded: remove the findings of the previous one from the editor
   * but keep them in the session cache, then restore those of the new one.
   * @param {string|null} docId - Stable id of the new document
   * @returns {void}
   */
  switchDocument(docId) {
    this._docId = null;
    this.clear();
    this.restore(docId);
  }

  /**
   * Drop the findings whose diagnostics the user dismissed in the diagnostics drawer.
   * @param {FixableDiagnostic[]} dismissed
   * @returns {void}
   */
  _forgetDismissed(dismissed) {
    const own = dismissed.filter(d => d.source === this._source);
    if (!own.length) return;
    const docText = this._getXmleditor().getView().state.doc.toString();
    this._setFindings(this._findings.filter(f => {
      const range = locateFinding(f, docText);
      return !own.some(d => range && d.from === range.from && d.message === f.rationale);
    }));
  }

  /**
   * Store findings and display them as diagnostics.
   * @param {Finding[]} findings
   * @param {boolean} [openPanel] Expand the diagnostics drawer
   * @returns {void}
   */
  show(findings, openPanel = true) {
    this._setFindings(findings);
    this._renderFindings(openPanel);
  }

  /**
   * Add findings to the current ones (e.g. those of the next part of a running review) and display
   * them, keeping the findings the user has dismissed or applied in the meantime removed. The ids
   * of the added findings are renumbered after the current ones; findings whose `old` equals that
   * of a current (or earlier added) finding are skipped.
   * @param {Finding[]} findings
   * @param {boolean} [openPanel] Expand the diagnostics drawer
   * @returns {number} The number of findings added
   */
  append(findings, openPanel = true) {
    const olds = new Set(this._findings.map(f => f.old));
    let nextId = this._findings.reduce((max, f) => Math.max(max, f.id), -1) + 1;
    /** @type {Finding[]} */
    const added = [];
    for (const finding of findings) {
      if (olds.has(finding.old)) continue;
      olds.add(finding.old);
      added.push({ ...finding, id: nextId++ });
    }
    if (!added.length) return 0;
    this._setFindings([...this._findings, ...added]);
    this._renderFindings(openPanel);
    return added.length;
  }

  /**
   * Remove all findings and their diagnostics.
   * @returns {void}
   */
  clear() {
    if (!this._findings.length) return;
    this._setFindings([]);
    this._renderFindings();
  }

  /**
   * Drop findings whose `old` text no longer occurs exactly once (e.g. after a proposed fix was
   * applied), so no stale highlights remain.
   * @returns {void}
   */
  _pruneFindings() {
    const docText = this._getXmleditor().getView().state.doc.toString();
    const kept = this._findings.filter(f => locateFinding(f, docText) !== null);
    if (kept.length === this._findings.length) return;
    this._setFindings(kept);
    this._renderFindings(false);
  }

  /**
   * Merge diagnostics for the stored findings into the editor's diagnostics.
   * @param {boolean} [openPanel] Expand the diagnostics drawer (only for user-initiated display)
   * @returns {void}
   */
  _renderFindings(openPanel = false) {
    const view = this._getXmleditor().getView();
    const own = findingsToDiagnostics(this._findings, view.state.doc.toString(), this._proposeFix);
    this._rendering = true;
    try {
      this._getLintUtils().applyMergedDiagnostics(view, this._source, own, { openPanel });
    } finally {
      this._rendering = false;
    }
  }
}

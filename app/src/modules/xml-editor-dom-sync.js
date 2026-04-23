/**
 * XML editor DOM <-> syntax tree synchronisation.
 *
 * Encapsulates the two-way mapping between the CodeMirror Lezer syntax tree and a
 * DOM document produced by `DOMParser`. The goal of this class is to make the
 * state machine around "XML in the editor is valid / invalid / has diverging
 * trees" explicit and testable, and to guarantee that transient malformed states
 * (which are normal during editing) never leave the editor in an unrecoverable
 * state.
 *
 * Key invariants:
 *   1. `getXmlTree()` returns the most recent *parseable* DOM document, even if
 *      the editor content is currently malformed. Callers that must know whether
 *      it reflects the current editor text check {@link isSynced}.
 *   2. A failed link step (tag mismatch, child-count mismatch) never discards the
 *      previous good tree or maps. It leaves `isSynced` false and records the
 *      error in {@link getLastSyncError}.
 *   3. The result object returned from {@link sync} reports the outcome to the
 *      caller (e.g. `XMLEditor`) so it can emit the appropriate events without
 *      inspecting internal state.
 *
 * The concrete parsing/linking logic lives in:
 *   - `DOMParser.parseFromString` (browser API) for text -> DOM.
 *   - `linkSyntaxTreeWithDOM` from `codemirror-utils.js` for DOM <-> syntax map.
 *
 * @import {SyntaxNode, Tree} from '@lezer/common'
 * @import {EditorView} from '@codemirror/view'
 * @import {Diagnostic} from '@codemirror/lint'
 */

import { syntaxTree, syntaxParserRunning } from '@codemirror/language';
import { linkSyntaxTreeWithDOM, parseXmlError } from './codemirror/codemirror-utils.js';

/**
 * @typedef {object} ProcessingInstructionData
 * @property {string} target
 * @property {string} data
 * @property {number} position
 * @property {string} fullText
 */

/**
 * @typedef {object} SyncError
 * @property {'parse' | 'link'} stage - Where the failure occurred.
 * @property {string} message - Human-readable description.
 * @property {Diagnostic} [diagnostic] - Present for `stage === 'parse'`; carries
 *   position info suitable for CodeMirror lint display.
 */

/**
 * @typedef {object} SyncResult
 * @property {boolean} ok - True if both parse and link succeeded.
 * @property {'wellFormed' | 'malformed' | 'linkFailed' | 'empty'} status -
 *   Fine-grained outcome for event emission by the caller.
 * @property {Diagnostic} [diagnostic] - Parser diagnostic when `status === 'malformed'`.
 * @property {Error} [linkError] - Original error when `status === 'linkFailed'`.
 */

/**
 * @typedef {object} Logger
 * @property {(message: any) => void} debug
 * @property {(message: any) => void} warn
 * @property {(message: any) => void} error
 */

export class XmlEditorDomSync {
  /** Latest successfully-parsed DOM tree. Null only before first successful parse or after {@link clear}. @type {Document | null} */
  #lastGoodXmlTree = null;

  /** Latest successfully-captured Lezer syntax tree. @type {Tree | null} */
  #lastGoodSyntaxTree = null;

  /** syntax node position -> DOM node. Null if never linked or after {@link clear}. @type {Map<number, Node> | null} */
  #syntaxToDom = null;

  /** DOM node -> syntax node position. @type {Map<Node, number> | null} */
  #domToSyntax = null;

  /** @type {ProcessingInstructionData[]} */
  #processingInstructions = [];

  /** Cached editor text content from the most recent {@link sync}. @type {string} */
  #editorContent = '';

  /**
   * True iff `#lastGoodXmlTree`, `#lastGoodSyntaxTree`, and the maps reflect the
   * current editor text. Becomes false whenever the editor text diverges (either
   * because parsing fails, linking fails, or {@link clear} was called).
   * @type {boolean}
   */
  #isSynced = false;

  /** @type {SyncError | null} */
  #lastSyncError = null;

  /** @type {Logger} */
  #logger;

  /**
   * @param {object} [options]
   * @param {Logger} [options.logger]
   */
  constructor({ logger } = {}) {
    this.#logger = logger ?? /** @type {Logger} */ (/** @type {unknown} */ (console));
  }

  /**
   * Re-parse the editor content and, if well-formed, link its syntax tree to the
   * DOM. Returns a {@link SyncResult} describing the outcome; throws only on
   * programming errors (never on malformed input or link failures).
   *
   * On failure the previous last-known-good tree and maps are preserved so that
   * callers can continue to serve navigation/query requests.
   *
   * @param {EditorView} view
   * @returns {Promise<SyncResult>}
   */
  async sync(view) {
    const content = view.state.doc.toString();
    this.#editorContent = content;

    if (content.trim() === '') {
      // Empty editor: reset everything, not treated as an error.
      this.#lastGoodXmlTree = null;
      this.#lastGoodSyntaxTree = null;
      this.#syntaxToDom = null;
      this.#domToSyntax = null;
      this.#processingInstructions = [];
      this.#isSynced = false;
      this.#lastSyncError = null;
      return { ok: false, status: 'empty' };
    }

    // Stage 1: parse text -> DOM.
    const doc = new DOMParser().parseFromString(content, 'application/xml');
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      const diagnostic = parseXmlError(errorNode, view.state.doc);
      this.#isSynced = false;
      this.#lastSyncError = {
        stage: 'parse',
        message: `Line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`,
        diagnostic
      };
      this.#logger.debug(
        `XmlEditorDomSync: parse failed (${this.#lastSyncError.message}); keeping last-good tree.`
      );
      return { ok: false, status: 'malformed', diagnostic };
    }

    // Stage 2: wait for the syntax parser if it is still processing the latest text.
    if (syntaxParserRunning(view)) {
      while (syntaxParserRunning(view)) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const newSyntaxTree = syntaxTree(view.state);

    // Stage 3: link syntax tree to DOM.
    try {
      const { syntaxToDom, domToSyntax } = linkSyntaxTreeWithDOM(
        view,
        newSyntaxTree.topNode,
        doc
      );
      this.#lastGoodXmlTree = doc;
      this.#lastGoodSyntaxTree = newSyntaxTree;
      this.#syntaxToDom = syntaxToDom;
      this.#domToSyntax = domToSyntax;
      this.#processingInstructions = this.#detectProcessingInstructions(doc);
      this.#isSynced = true;
      this.#lastSyncError = null;
      return { ok: true, status: 'wellFormed' };
    } catch (error) {
      this.#isSynced = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#lastSyncError = { stage: 'link', message: err.message };
      this.#logger.warn(
        `XmlEditorDomSync: link failed (${err.message}); keeping previous maps.`
      );
      return { ok: false, status: 'linkFailed', linkError: err };
    }
  }

  /**
   * Reset all state. Called when the editor is cleared or a new document is loaded.
   */
  clear() {
    this.#lastGoodXmlTree = null;
    this.#lastGoodSyntaxTree = null;
    this.#syntaxToDom = null;
    this.#domToSyntax = null;
    this.#processingInstructions = [];
    this.#editorContent = '';
    this.#isSynced = false;
    this.#lastSyncError = null;
  }

  /**
   * Returns the most recent successfully-parsed DOM document. This may be stale
   * if the editor content has since become malformed or the link step has failed;
   * use {@link isSynced} to determine freshness.
   * @returns {Document | null}
   */
  getXmlTree() {
    return this.#lastGoodXmlTree;
  }

  /** @returns {Tree | null} */
  getSyntaxTree() {
    return this.#lastGoodSyntaxTree;
  }

  /** @returns {Map<number, Node> | null} */
  getSyntaxToDom() {
    return this.#syntaxToDom;
  }

  /** @returns {Map<Node, number> | null} */
  getDomToSyntax() {
    return this.#domToSyntax;
  }

  /** @returns {ProcessingInstructionData[]} */
  getProcessingInstructions() {
    return this.#processingInstructions;
  }

  /** @returns {string} */
  getEditorContent() {
    return this.#editorContent;
  }

  /**
   * True iff the last-good trees and maps reflect the editor text at the time of
   * the most recent {@link sync}. Callers that mutate the DOM tree and push the
   * result back into the editor MUST check this.
   * @returns {boolean}
   */
  isSynced() {
    return this.#isSynced;
  }

  /** @returns {SyncError | null} */
  getLastSyncError() {
    return this.#lastSyncError;
  }

  /**
   * @param {Document} xmlTree
   * @returns {ProcessingInstructionData[]}
   */
  #detectProcessingInstructions(xmlTree) {
    /** @type {ProcessingInstructionData[]} */
    const out = [];
    for (let i = 0; i < xmlTree.childNodes.length; i++) {
      const node = xmlTree.childNodes[i];
      if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
        const piNode = /** @type {ProcessingInstruction} */ (node);
        out.push({
          target: piNode.target,
          data: piNode.data,
          position: i,
          fullText: `<?${piNode.target}${piNode.data ? ' ' + piNode.data : ''}?>`
        });
      }
    }
    return out;
  }
}

export default XmlEditorDomSync;

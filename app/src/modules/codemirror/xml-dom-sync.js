/**
 * CodeMirror v6 extension that synchronizes the editor's Lezer syntax tree
 * with a DOM XML tree parsed by DOMParser. Provides bidirectional maps between
 * syntax node positions and DOM nodes, tracks XML well-formedness, and detects
 * processing instructions.
 *
 * @example
 * import { EditorView } from "@codemirror/view";
 * import { EditorState, Compartment } from "@codemirror/state";
 * import { xmlDomSync, xmlDomSyncField, xmlTree, syntaxToDomMap, requestSyncEffect } from "./xml-dom-sync.js";
 *
 * // Add the extension (optionally via a Compartment for reconfiguration)
 * const syncCompartment = new Compartment();
 * const view = new EditorView({
 *   state: EditorState.create({
 *     doc: '<root><child/></root>',
 *     extensions: [
 *       syncCompartment.of(xmlDomSync({ debounceMs: 1000 })),
 *       // Observe sync state transitions
 *       EditorView.updateListener.of(update => {
 *         const oldSync = update.startState.field(xmlDomSyncField);
 *         const newSync = update.state.field(xmlDomSyncField);
 *         if (newSync.syncVersion !== oldSync.syncVersion) {
 *           console.log("Sync completed, well-formed:", newSync.isWellFormed);
 *           console.log("DOM tree:", xmlTree(update.view));
 *           console.log("Map entries:", syntaxToDomMap(update.view).size);
 *         }
 *       })
 *     ]
 *   })
 * });
 *
 * // Force an immediate sync (bypasses debounce)
 * view.dispatch({ effects: requestSyncEffect() });
 *
 * @module xml-dom-sync
 */

/**
 * @import {Extension} from '@codemirror/state'
 * @import {ViewUpdate} from '@codemirror/view'
 * @import {Diagnostic} from '@codemirror/lint'
 */

/**
 * @typedef {Diagnostic & {line?: number, column?: number}} ExtendedDiagnostic
 */

/**
 * @typedef {object} ProcessingInstructionData
 * @property {string} target
 * @property {string} data
 * @property {Number} position
 * @property {string} fullText
 */

/**
 * @typedef {Object} XmlDomSyncMetadata
 * @property {boolean} isWellFormed - Whether the current XML is well-formed
 * @property {ExtendedDiagnostic[]} diagnostics - Parse error diagnostics (empty when valid)
 * @property {number} syncVersion - Incremented on each successful sync
 */

/**
 * @typedef {Object} XmlDomSyncConfig
 * @property {number} [debounceMs] - Debounce delay in ms (default 1000)
 */

import { StateField, StateEffect, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { linkSyntaxTreeWithDOM } from "./xml-dom-link.js";

// ─── StateEffects ───────────────────────────────────────────────────────────

/** @type {StateEffect<{syncVersion: number}>} */
const syncSucceeded = StateEffect.define();

/** @type {StateEffect<{diagnostics: ExtendedDiagnostic[]}>} */
const syncFailed = StateEffect.define();

/** @type {StateEffect<null>} */
const requestSync = StateEffect.define();

// ─── Facet (configuration) ──────────────────────────────────────────────────

/** @type {Facet<Partial<XmlDomSyncConfig>, XmlDomSyncConfig>} */
const xmlDomSyncConfig = Facet.define({
  combine(configs) {
    return {
      debounceMs: configs.reduce((a, c) => c.debounceMs ?? a, 1000),
    };
  }
});

// ─── StateField (immutable metadata) ────────────────────────────────────────

/** @type {StateField<XmlDomSyncMetadata>} */
export const xmlDomSyncField = StateField.define({
  create() {
    return {
      isWellFormed: false,
      diagnostics: [],
      syncVersion: 0
    };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(syncSucceeded)) {
        return {
          isWellFormed: true,
          diagnostics: [],
          syncVersion: effect.value.syncVersion
        };
      }
      if (effect.is(syncFailed)) {
        return {
          ...value,
          isWellFormed: false,
          diagnostics: effect.value.diagnostics
        };
      }
    }
    return value;
  }
});

// ─── ViewPlugin (mutable state + sync engine) ───────────────────────────────

const xmlDomSyncPlugin = ViewPlugin.fromClass(
  class {
    /** @type {Document | null} */
    xmlTree = null;

    /** @type {Map<number, Node>} */
    syntaxToDom = new Map();

    /** @type {Map<Node, number>} */
    domToSyntax = new Map();

    /** @type {ProcessingInstructionData[]} */
    processingInstructions = [];

    /** @type {number} */
    syncVersion = 0;

    /** @type {ReturnType<typeof setTimeout> | null} */
    debounceTimer = null;

    /** @type {boolean} */
    syncInProgress = false;

    /** @type {boolean} */
    destroyed = false;

    /** @type {string} */
    lastSyncedContent = '';

    /**
     * @param {EditorView} view
     */
    constructor(view) {
      if (view.state.doc.length > 0) {
        setTimeout(() => this.performSync(view), 0);
      }
    }

    /**
     * @param {ViewUpdate} update
     */
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(requestSync)) {
            this.cancelDebounce();
            setTimeout(() => this.performSync(update.view), 0);
            return;
          }
        }
      }

      if (update.docChanged) {
        this.cancelDebounce();
        const config = update.state.facet(xmlDomSyncConfig);
        this.debounceTimer = setTimeout(
          () => this.performSync(update.view),
          config.debounceMs
        );
      }
    }

    /**
     * @param {EditorView} view
     */
    performSync(view) {
      if (this.destroyed || this.syncInProgress) return;
      this.syncInProgress = true;

      try {
        const content = view.state.doc.toString();

        // Skip if content hasn't changed since last successful sync
        if (content === this.lastSyncedContent) return;

        if (content.trim() === '') {
          this.xmlTree = null;
          this.syntaxToDom = new Map();
          this.domToSyntax = new Map();
          this.processingInstructions = [];
          this.lastSyncedContent = content;
          view.dispatch({ effects: syncFailed.of({ diagnostics: [] }) });
          return;
        }

        // Parse XML
        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const errorNode = doc.querySelector('parsererror');

        if (errorNode) {
          const diagnostics = parseErrorNode(errorNode, view.state.doc);
          this.xmlTree = null;
          this.syntaxToDom = new Map();
          this.domToSyntax = new Map();
          this.processingInstructions = [];
          view.dispatch({ effects: syncFailed.of({ diagnostics }) });
          return;
        }

        // XML is well-formed
        this.xmlTree = doc;

        // Ensure syntax tree is available (synchronous, with 5s timeout)
        const tree = ensureSyntaxTree(view.state, view.state.doc.length, 5000);
        if (!tree) {
          // Parser didn't finish in time — reschedule
          this.debounceTimer = setTimeout(() => this.performSync(view), 500);
          return;
        }

        // Build maps
        const getText = (/** @type {number} */ from, /** @type {number} */ to) =>
          view.state.doc.sliceString(from, to);
        try {
          const maps = linkSyntaxTreeWithDOM(getText, tree.topNode, doc);
          this.syntaxToDom = maps.syntaxToDom;
          this.domToSyntax = maps.domToSyntax;
        } catch (error) {
          console.warn('Linking DOM and syntax tree failed:', String(error));
          this.syntaxToDom = new Map();
          this.domToSyntax = new Map();
        }

        // Detect processing instructions
        this.processingInstructions = detectProcessingInstructions(doc);

        this.lastSyncedContent = content;
        this.syncVersion++;
        view.dispatch({
          effects: syncSucceeded.of({ syncVersion: this.syncVersion })
        });
      } finally {
        this.syncInProgress = false;
      }
    }

    cancelDebounce() {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
    }

    destroy() {
      this.cancelDebounce();
      this.destroyed = true;
    }
  }
);

// ─── Accessor functions ─────────────────────────────────────────────────────

/**
 * Get the XML DOM tree from the view.
 * @param {EditorView} view
 * @returns {Document | null}
 */
export function xmlTree(view) {
  return view.plugin(xmlDomSyncPlugin)?.xmlTree ?? null;
}

/**
 * Get the syntax-to-DOM map from the view.
 * @param {EditorView} view
 * @returns {Map<number, Node>}
 */
export function syntaxToDomMap(view) {
  return view.plugin(xmlDomSyncPlugin)?.syntaxToDom ?? new Map();
}

/**
 * Get the DOM-to-syntax map from the view.
 * @param {EditorView} view
 * @returns {Map<Node, number>}
 */
export function domToSyntaxMap(view) {
  return view.plugin(xmlDomSyncPlugin)?.domToSyntax ?? new Map();
}

/**
 * Get processing instructions from the view.
 * @param {EditorView} view
 * @returns {ProcessingInstructionData[]}
 */
export function xmlSyncProcessingInstructions(view) {
  return view.plugin(xmlDomSyncPlugin)?.processingInstructions ?? [];
}

/**
 * Create a requestSync StateEffect for dispatching.
 * @returns {StateEffect<null>}
 */
export function requestSyncEffect() {
  return requestSync.of(null);
}

// ─── Extension factory ──────────────────────────────────────────────────────

/**
 * Creates the XML DOM sync extension.
 * @param {Partial<XmlDomSyncConfig>} [config]
 * @returns {Extension}
 */
export function xmlDomSync(config = {}) {
  return [
    xmlDomSyncConfig.of(config),
    xmlDomSyncField,
    xmlDomSyncPlugin
  ];
}

// ─── Helper functions ───────────────────────────────────────────────────────

/**
 * Parse a DOMParser error node into diagnostics.
 * Handles error formats from Chrome, Firefox, and Safari.
 * @param {Node} errorNode The error node containing parse errors
 * @param {import("@codemirror/state").Text} doc The editor document (for line resolution)
 * @returns {ExtendedDiagnostic[]}
 */
function parseErrorNode(errorNode, doc) {
  const severity = "error";
  const textContent = errorNode.firstChild?.textContent;
  if (!textContent) {
    return [];
  }

  // Chrome/Chromium format: "message\n...\nLine N, Column N"
  const chromeMatch = textContent.match(/^(.+?)[\r\n].*?line\s+(\d+).*?column\s+(\d+)/is);
  if (chromeMatch) {
    const message = chromeMatch[1].trim();
    const line = parseInt(chromeMatch[2], 10);
    const column = parseInt(chromeMatch[3], 10);
    try {
      let { from, to } = doc.line(line);
      from = from + column - 1;
      return [{ message, severity, line, column, from, to }];
    } catch {
      return [{ message, severity, from: 0, to: 0 }];
    }
  }

  // Firefox format: error message with <sourcetext> child element,
  // "XML Parsing Error: message\nLocation: ...\nLine Number N, Column N:"
  const sourceText = /** @type {Element} */ (errorNode).querySelector?.('sourcetext');
  if (sourceText) {
    const firefoxMatch = textContent.match(/line\s*number\s*(\d+).*?column\s*(\d+)/i);
    if (firefoxMatch) {
      const line = parseInt(firefoxMatch[1], 10);
      const column = parseInt(firefoxMatch[2], 10);
      const message = textContent.split('\n')[0].replace(/^XML Parsing Error:\s*/i, '').trim();
      try {
        let { from, to } = doc.line(line);
        from = from + column - 1;
        return [{ message, severity, line, column, from, to }];
      } catch {
        return [{ message, severity, from: 0, to: 0 }];
      }
    }
  }

  // Fallback: extract any two numbers (line, column) from the text
  const genericMatch = textContent.match(/(\d+)/g);
  if (genericMatch && genericMatch.length >= 2) {
    const message = textContent.split('\n')[0];
    const line = parseInt(genericMatch[0], 10);
    const column = parseInt(genericMatch[1], 10);
    try {
      let { from, to } = doc.line(line);
      from = from + column - 1;
      return [{ message, severity, line, column, from, to }];
    } catch {
      return [{ message: textContent, severity, from: 0, to: 0 }];
    }
  }

  return [{ message: textContent, severity, from: 0, to: 0 }];
}

/**
 * Detect processing instructions in an XML document.
 * @param {Document} xmlDoc
 * @returns {ProcessingInstructionData[]}
 */
function detectProcessingInstructions(xmlDoc) {
  /** @type {ProcessingInstructionData[]} */
  const result = [];
  for (let i = 0; i < xmlDoc.childNodes.length; i++) {
    const node = xmlDoc.childNodes[i];
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      const piNode = /** @type {ProcessingInstruction} */ (node);
      result.push({
        target: piNode.target,
        data: piNode.data,
        position: i,
        fullText: `<?${piNode.target}${piNode.data ? ' ' + piNode.data : ''}?>`
      });
    }
  }
  return result;
}

// Re-export for consumers that import from this module
export { linkSyntaxTreeWithDOM };

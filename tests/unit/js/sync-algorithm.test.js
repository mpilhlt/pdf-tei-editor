#!/usr/bin/env node

/**
 * Test suite for XmlEditorDomSync — the class that encapsulates the DOM <->
 * syntax tree synchronisation algorithm used by the XML editor.
 *
 * Uses a real CodeMirror EditorView (backed by jsdom) so the tests exercise the
 * real `linkSyntaxTreeWithDOM` implementation, real DOMParser, and real Lezer
 * syntax tree — no inlined algorithm copy.
 *
 * The key behaviours under test:
 *   1. Successful sync populates the last-good tree and maps and marks the
 *      instance as synced.
 *   2. A malformed edit is reported via `status: 'malformed'` and preserves the
 *      previous last-good tree and maps (so navigation does not break).
 *   3. Recovery: when the content becomes well-formed again, sync returns
 *      `status: 'wellFormed'` and updates the maps to reflect the new text.
 *   4. An empty document returns `status: 'empty'` and clears state.
 *   5. Processing-instruction handling: xml-stylesheet / xml-model PIs before the
 *      root element do not break the sync and are reported via
 *      `getProcessingInstructions()`.
 *
 * @testCovers app/src/modules/xml-editor-dom-sync.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Set up jsdom globals BEFORE importing CodeMirror (it probes for `document`).
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;

if (!global.window.getSelection) {
  global.window.getSelection = () => ({
    rangeCount: 0,
    addRange() {},
    removeAllRanges() {},
    getRangeAt() { return { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 }; }
  });
}
if (!global.document.getSelection) {
  global.document.getSelection = global.window.getSelection;
}
if (!global.Range) global.Range = dom.window.Range;
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;

const { EditorState } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const { xml } = await import('@codemirror/lang-xml');
const { ensureSyntaxTree } = await import('@codemirror/language');
const { XmlEditorDomSync } = await import('../../../app/src/modules/xml-editor-dom-sync.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a real EditorView containing the given XML.
 * @param {string} doc
 * @returns {EditorView}
 */
function createView(doc) {
  const parent = document.getElementById('editor');
  parent.innerHTML = '';
  const state = EditorState.create({
    doc,
    extensions: [xml()]
  });
  return new EditorView({ state, parent });
}

/**
 * Force the Lezer syntax tree to be fully parsed so that
 * `syntaxTree(view.state)` returns a finalised tree.
 * @param {EditorView} view
 */
function forceParse(view) {
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
}

/**
 * Dispatch a change to the editor and force re-parse.
 * @param {EditorView} view
 * @param {{ from: number, to: number, insert: string }} change
 */
function applyChange(view, change) {
  view.dispatch({ changes: change });
  forceParse(view);
}

/**
 * Silent logger used to keep test output clean when testing error paths.
 */
const silentLogger = {
  debug() {},
  warn() {},
  error() {}
};

/**
 * Run `fn` with `console.warn` silenced. jsdom's XML parsererror format is not
 * recognised by `parseXmlError`, which logs a `console.warn` on every malformed
 * parse; that is expected and not a test failure — suppress it so the test
 * output stays clean.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withSilencedConsoleWarn(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('XmlEditorDomSync', () => {

  describe('successful sync', () => {

    it('parses and links a simple well-formed document', async () => {
      const view = createView('<root><child>hello</child></root>');
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      const result = await sync.sync(view);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'wellFormed');
      assert.strictEqual(sync.isSynced(), true);
      assert.strictEqual(sync.getLastSyncError(), null);

      const tree = sync.getXmlTree();
      assert.ok(tree, 'xml tree should be available');
      assert.strictEqual(tree.documentElement.tagName, 'root');

      const s2d = sync.getSyntaxToDom();
      const d2s = sync.getDomToSyntax();
      assert.ok(s2d instanceof Map && s2d.size > 0, 'syntaxToDom populated');
      assert.ok(d2s instanceof Map && d2s.size > 0, 'domToSyntax populated');
      assert.ok(d2s.has(tree.documentElement), 'root element linked');
    });

    it('populates editor content cache', async () => {
      const text = '<root><a/></root>';
      const view = createView(text);
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      await sync.sync(view);

      assert.strictEqual(sync.getEditorContent(), text);
    });

    it('handles nested elements correctly', async () => {
      const view = createView('<a><b><c><d/></c></b></a>');
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      const result = await sync.sync(view);

      assert.strictEqual(result.ok, true);
      const tree = sync.getXmlTree();
      // There are 4 elements (a/b/c/d) — each should be in the domToSyntax map.
      assert.strictEqual(sync.getDomToSyntax().size, 4);
      assert.strictEqual(tree.documentElement.tagName, 'a');
    });
  });

  describe('malformed input preserves last-good tree', () => {

    it('reports malformed status without discarding previous tree', async () => {
      await withSilencedConsoleWarn(async () => {
        const view = createView('<root><child>hello</child></root>');
        forceParse(view);
        const sync = new XmlEditorDomSync({ logger: silentLogger });

        // First sync — valid document populates the last-good tree.
        const firstResult = await sync.sync(view);
        assert.strictEqual(firstResult.status, 'wellFormed');
        const firstTree = sync.getXmlTree();
        const firstMap = sync.getDomToSyntax();
        assert.ok(firstTree);
        assert.ok(firstMap);

        // Break the document by deleting the closing `>` of the opening tag.
        // "<root><child>hello</child></root>" → "<root<child>hello</child></root>"
        applyChange(view, { from: 5, to: 6, insert: '' });
        const secondResult = await sync.sync(view);

        assert.strictEqual(secondResult.ok, false);
        assert.strictEqual(secondResult.status, 'malformed');
        assert.ok(secondResult.diagnostic, 'diagnostic should be reported');
        assert.strictEqual(typeof secondResult.diagnostic.message, 'string');
        assert.strictEqual(sync.isSynced(), false);

        // The last-good tree and maps MUST be preserved.
        assert.strictEqual(
          sync.getXmlTree(),
          firstTree,
          'last-good xml tree should be preserved after malformed edit'
        );
        assert.strictEqual(
          sync.getDomToSyntax(),
          firstMap,
          'last-good domToSyntax map should be preserved after malformed edit'
        );

        const err = sync.getLastSyncError();
        assert.ok(err, 'lastSyncError should be recorded');
        assert.strictEqual(err.stage, 'parse');
      });
    });

    it('recovers when the document becomes well-formed again', async () => {
      await withSilencedConsoleWarn(async () => {
        const view = createView('<root><child>hello</child></root>');
        forceParse(view);
        const sync = new XmlEditorDomSync({ logger: silentLogger });

        await sync.sync(view);

        // Break it.
        applyChange(view, { from: 5, to: 6, insert: '' });
        const malformed = await sync.sync(view);
        assert.strictEqual(malformed.status, 'malformed');
        assert.strictEqual(sync.isSynced(), false);

        // Re-insert the `>` to repair the document.
        applyChange(view, { from: 5, to: 5, insert: '>' });
        const recovered = await sync.sync(view);

        assert.strictEqual(recovered.ok, true);
        assert.strictEqual(recovered.status, 'wellFormed');
        assert.strictEqual(sync.isSynced(), true);
        assert.strictEqual(sync.getLastSyncError(), null);
        const tree = sync.getXmlTree();
        assert.ok(tree);
        assert.strictEqual(tree.documentElement.tagName, 'root');
      });
    });

    it('keeps maps available for navigation queries while malformed', async () => {
      await withSilencedConsoleWarn(async () => {
        const view = createView('<root><child>hello</child></root>');
        forceParse(view);
        const sync = new XmlEditorDomSync({ logger: silentLogger });

        await sync.sync(view);
        const preserved = sync.getXmlTree();

        // Break the document.
        applyChange(view, { from: 5, to: 6, insert: '' });
        await sync.sync(view);

        // Navigation-style queries still work off the last-good tree.
        assert.ok(sync.getXmlTree() === preserved);
        const rootEl = sync.getXmlTree().documentElement;
        assert.ok(sync.getDomToSyntax().has(rootEl));
      });
    });
  });

  describe('empty document', () => {

    it('returns status: empty and clears state', async () => {
      const view = createView('<root/>');
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      await sync.sync(view);
      assert.ok(sync.getXmlTree());

      // Clear editor content.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      forceParse(view);

      const result = await sync.sync(view);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 'empty');
      assert.strictEqual(sync.getXmlTree(), null);
      assert.strictEqual(sync.getDomToSyntax(), null);
      assert.strictEqual(sync.getSyntaxToDom(), null);
      assert.strictEqual(sync.getProcessingInstructions().length, 0);
      assert.strictEqual(sync.isSynced(), false);
    });
  });

  describe('clear()', () => {

    it('resets all state', async () => {
      const view = createView('<root><a/></root>');
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      await sync.sync(view);
      assert.ok(sync.getXmlTree());
      assert.strictEqual(sync.isSynced(), true);

      sync.clear();

      assert.strictEqual(sync.getXmlTree(), null);
      assert.strictEqual(sync.getSyntaxTree(), null);
      assert.strictEqual(sync.getDomToSyntax(), null);
      assert.strictEqual(sync.getSyntaxToDom(), null);
      assert.strictEqual(sync.getEditorContent(), '');
      assert.strictEqual(sync.isSynced(), false);
      assert.strictEqual(sync.getLastSyncError(), null);
      assert.strictEqual(sync.getProcessingInstructions().length, 0);
    });
  });

  describe('processing instructions', () => {

    it('detects PIs before the root element', async () => {
      const text =
        '<?xml-stylesheet href="style.xsl"?>' +
        '<?custom-pi data="test"?>' +
        '<root><child>content</child></root>';
      const view = createView(text);
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      const result = await sync.sync(view);
      assert.strictEqual(result.status, 'wellFormed');

      const pis = sync.getProcessingInstructions();
      assert.strictEqual(pis.length, 2);
      assert.strictEqual(pis[0].target, 'xml-stylesheet');
      assert.strictEqual(pis[1].target, 'custom-pi');
    });

    it('handles real-world TEI xml-model PI', async () => {
      const text =
        '<?xml-model href="https://example.org/tei.rng" ' +
        'type="application/xml" ' +
        'schematypens="http://relaxng.org/ns/structure/1.0"?>' +
        '<TEI xmlns="http://www.tei-c.org/ns/1.0">' +
        '<teiHeader><fileDesc><titleStmt><title>T</title></titleStmt>' +
        '<publicationStmt><p>P</p></publicationStmt>' +
        '<sourceDesc><p>S</p></sourceDesc></fileDesc></teiHeader>' +
        '<text><body><p>Content</p></body></text>' +
        '</TEI>';
      const view = createView(text);
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      const result = await sync.sync(view);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'wellFormed');
      const tree = sync.getXmlTree();
      assert.strictEqual(tree.documentElement.tagName, 'TEI');
      const pis = sync.getProcessingInstructions();
      assert.strictEqual(pis.length, 1);
      assert.strictEqual(pis[0].target, 'xml-model');
    });

    it('handles mixed content (comments + PIs + elements)', async () => {
      const text =
        '<!-- leading comment -->' +
        '<?xml-stylesheet href="s.xsl"?>' +
        '<!-- another comment -->' +
        '<root><c/></root>';
      const view = createView(text);
      forceParse(view);
      const sync = new XmlEditorDomSync({ logger: silentLogger });

      const result = await sync.sync(view);
      assert.strictEqual(result.status, 'wellFormed');
      assert.strictEqual(sync.getProcessingInstructions().length, 1);
      assert.strictEqual(sync.getXmlTree().documentElement.tagName, 'root');
    });
  });
});

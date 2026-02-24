// @ts-check

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { xml } from '@codemirror/lang-xml';
import { ensureSyntaxTree } from '@codemirror/language';
// @ts-ignore
import { xmlTagSync } from '/src/modules/codemirror/xml-tag-sync.js';

/** @param {string} doc */
function createView(doc) {
  const parent = /** @type {HTMLElement} */ (document.getElementById('editor'));
  parent.innerHTML = '';
  return new EditorView({
    state: EditorState.create({ doc, extensions: [xml(), xmlTagSync] }),
    parent,
  });
}

/**
 * @typedef {object} HarnessWindow
 * @property {(doc: string) => void} setContent
 * @property {(from: number, to: number, insert: string) => string} applyChange
 * @property {() => string} getContent
 * @property {(name: string, data: unknown) => void} testLog
 */

let view = createView('');

const w = /** @type {Window & HarnessWindow} */ (/** @type {unknown} */ (window));

w.setContent = /** @type {HarnessWindow['setContent']} */ ((doc) => { view = createView(doc); });

w.getContent = () => view.state.doc.toString();

/**
 * Apply a change, force a full synchronous parse, and return the resulting document.
 * Mirrors the `applyChange` helper used in the JSDOM unit tests.
 */
w.applyChange = /** @type {HarnessWindow['applyChange']} */ ((from, to, insert) => {
  view.dispatch({ changes: { from, to, insert } });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view.state.doc.toString();
});

w.testLog = /** @type {HarnessWindow['testLog']} */ ((name, data) => console.log(`TEST: ${name} ${JSON.stringify(data)}`));

w.testLog('EDITOR_READY', {});

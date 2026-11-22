#!/usr/bin/env node

/**
 * Verifies that XMLEditor.loadXml() discards the content of an outdated load: when a document is
 * loaded while another one is still fetched, the editor shows the newer document, whatever the
 * order in which the fetches complete (#893).
 *
 * @testCovers app/src/modules/xmleditor.js
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.Window = dom.window.Window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.XPathResult = dom.window.XPathResult;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
if (!global.window.getSelection) {
  global.window.getSelection = () => ({
    rangeCount: 0, addRange() {}, removeAllRanges() {},
    getRangeAt() { return { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 }; }
  });
}
if (!global.document.getSelection) global.document.getSelection = global.window.getSelection;
if (!global.Range) global.Range = dom.window.Range;
if (!global.StaticRange) global.StaticRange = dom.window.StaticRange;

const { XMLEditor } = await import('../../../app/src/modules/xmleditor.js');

const doc = (/** @type {string} */ p) => `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/><text><body><p>${p}</p></body></text></TEI>`;

/** @type {Map<string, {promise: Promise<void>, resolve: () => void}>} */
const pendingFetches = new Map();
const originalFetch = global.fetch;

/**
 * Serves `/doc/<p>` with the document {@link doc}(p), once the test releases the fetch.
 * @param {string} url
 */
global.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise(r => { resolve = () => r(undefined); });
  pendingFetches.set(url, { promise, resolve });
  await promise;
  const text = doc(url.split('/').pop() ?? '');
  return { status: 200, text: async () => text };
});

after(() => { global.fetch = originalFetch; });

/**
 * Waits until the fetch of the given URL has started
 * @param {string} url
 */
async function fetchStarted(url) {
  while (!pendingFetches.has(url)) await new Promise(r => setTimeout(r, 1));
  return /** @type {{promise: Promise<void>, resolve: () => void}} */ (pendingFetches.get(url));
}

describe('XMLEditor.loadXml order', () => {
  it('keeps the newer document when the outdated fetch completes last', async () => {
    document.getElementById('editor').innerHTML = '';
    const editor = new XMLEditor('editor');
    const first = editor.loadXml('/doc/First');
    const firstFetch = await fetchStarted('/doc/First');
    const second = editor.loadXml('/doc/Second');
    (await fetchStarted('/doc/Second')).resolve();
    const secondResult = await second;
    firstFetch.resolve();
    const firstResult = await first;
    assert.strictEqual(editor.getView().state.doc.toString(), doc('Second'));
    assert.ok(editor.getXmlTree()?.documentElement.textContent?.includes('Second'));
    assert.strictEqual(editor.isReady(), true);
    assert.deepStrictEqual([firstResult, secondResult], [false, true]);
  });

  it('keeps the newer document when the outdated fetch completes first', async () => {
    pendingFetches.clear();
    document.getElementById('editor').innerHTML = '';
    const editor = new XMLEditor('editor');
    const first = editor.loadXml('/doc/Third');
    const firstFetch = await fetchStarted('/doc/Third');
    const second = editor.loadXml('/doc/Fourth');
    const secondFetch = await fetchStarted('/doc/Fourth');
    firstFetch.resolve();
    // without the guard, the outdated load would wait for readiness until the newer one is ready
    await new Promise(r => setTimeout(r, 50));
    secondFetch.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.strictEqual(editor.getView().state.doc.toString(), doc('Fourth'));
    assert.strictEqual(editor.isReady(), true);
    assert.deepStrictEqual([firstResult, secondResult], [false, true]);
  });
});

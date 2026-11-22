#!/usr/bin/env node

/**
 * Unit tests for the version options shared by the "Target XML" (file-selection) and "Compare with
 * version" (merge-view) selectboxes.
 * @testCovers app/src/modules/version-options.js
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

// ui.js loads Shoelace; the options only need plain elements
mock.module('../../../app/src/ui.js', {
  namedExports: {
    SlOption: function SlOption() { return document.createElement('sl-option'); },
    SlDivider: function SlDivider() { return document.createElement('sl-divider'); }
  }
});

const { filterFileData, isSelectedFile, getSelectedFileVersions, appendVersionOptions } =
  await import('../../../app/src/modules/version-options.js');

/**
 * @param {string} id
 * @param {object} [extra]
 */
const artifact = (id, extra = {}) => ({ id, label: id, version: 1, ...extra });

const fileData = [
  {
    doc_id: 'doc1',
    collections: ['c1'],
    source: { id: 'pdf1', label: 'PDF 1', file_type: 'pdf' },
    artifacts: [
      artifact('gold', { is_gold_standard: true, is_frozen: true, variant: 'v1', version: 1 }),
      artifact('anna', { parent_id: 'gold', variant: 'v1', version: 2 }),
      artifact('other', { variant: 'v2', version: 1 })
    ]
  },
  {
    doc_id: 'doc2',
    collections: ['c2'],
    source: { id: 'xml2', label: 'XML source', file_type: 'xml' },
    artifacts: [artifact('x2')]
  }
];

/** @param {object} state */
const makeState = state => /** @type {any} */ ({ fileData, collectionFilter: null, variant: null, projects: [], ...state });

describe('version options', () => {
  it('finds the document selected by its PDF or by a non-PDF source', () => {
    assert.ok(isSelectedFile(/** @type {any} */ (fileData[0]), makeState({ pdf: 'pdf1' })));
    assert.ok(isSelectedFile(/** @type {any} */ (fileData[1]), makeState({ xml: 'xml2' })));
    assert.ok(!isSelectedFile(/** @type {any} */ (fileData[0]), makeState({ xml: 'pdf1' })));
  });

  it('lists the versions of the selected document, filtered by variant', () => {
    const state = makeState({ pdf: 'pdf1', variant: 'v1' });
    const ids = getSelectedFileVersions(filterFileData(state), state).map(v => v.id);
    assert.deepStrictEqual(ids, ['gold', 'anna']);
  });

  it('lists no versions when the selected document is filtered out by the collection filter', () => {
    const state = makeState({ pdf: 'pdf1', collectionFilter: 'c2' });
    assert.deepStrictEqual(getSelectedFileVersions(filterFileData(state), state), []);
  });

  it('does not change the file data of the state', () => {
    const state = makeState({ pdf: 'pdf1', collectionFilter: 'c1' });
    filterFileData(state);
    assert.deepStrictEqual(fileData[0].collections, ['c1']);
  });

  it('renders lineages with the gold group first and ancestors after the leaves', () => {
    const state = makeState({ pdf: 'pdf1' });
    const select = /** @type {any} */ (document.createElement('div'));
    appendVersionOptions(select, getSelectedFileVersions(filterFileData(state), state), state.variant);
    const layout = Array.from(select.children).map((/** @type {any} */ el) =>
      el.tagName === 'SL-OPTION' ? el.value : el.tagName === 'SL-DIVIDER' ? '|' : 'arrow');
    assert.deepStrictEqual(layout, ['anna', 'arrow', 'gold', '|', 'other']);
    const gold = select.children[2];
    assert.strictEqual(gold.dataset.gold, 'true');
    assert.ok(gold.classList.contains('lineage-ancestor-last'));
    assert.match(select.children[0].innerHTML, /anna \[v1\]/, 'the variant is shown without a variant filter');
  });
});

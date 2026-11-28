#!/usr/bin/env node

/**
 * Test suite for the selectionMatches CodeMirror extension (#962).
 *
 * Creates a real CodeMirror EditorView in jsdom and verifies that selection
 * matches are hidden while the search panel is open.
 *
 * @testCovers app/src/modules/codemirror/selection-matches.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Set up jsdom globals BEFORE importing CodeMirror (it probes for `document`).
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
dom.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
global.window = dom.window;
global.Window = dom.window.Window;
global.document = dom.window.document;
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

const { EditorState, EditorSelection } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const { openSearchPanel, closeSearchPanel, setSearchQuery, SearchQuery } = await import('@codemirror/search');
const { selectionMatches, SEARCH_OPEN_CLASS } = await import('../../../app/src/modules/codemirror/selection-matches.js');

const DOC = '<listBibl>\n<bibl>x</bibl>\n</listBibl>\n<listBibl>\n</listBibl>';

/**
 * Create an EditorView with the first `<listBibl>` selected.
 * @returns {EditorView}
 */
function createView() {
  const parent = document.getElementById('editor');
  parent.innerHTML = '';
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.single(0, '<listBibl>'.length),
    extensions: [selectionMatches()]
  });
  return new EditorView({ state, parent });
}

/**
 * @returns {string} The text of all CSS rules in the document
 */
function allCss() {
  const fromTags = [...document.querySelectorAll('style')].map(s => s.textContent);
  const fromAdopted = [...(document.adoptedStyleSheets ?? [])]
    .flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText));
  return [...fromTags, ...fromAdopted].join('\n');
}

describe('selectionMatches', () => {
  it('highlights other occurrences of the selection while the search panel is closed', () => {
    const view = createView();
    assert.ok(view.dom.querySelectorAll('.cm-selectionMatch').length > 0);
    assert.ok(!view.dom.classList.contains(SEARCH_OPEN_CLASS));
    view.destroy();
  });

  it('marks the editor while the search panel is open and unmarks it when closed', () => {
    const view = createView();
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '</listBibl>' })) });
    assert.ok(view.dom.classList.contains(SEARCH_OPEN_CLASS));
    closeSearchPanel(view);
    assert.ok(!view.dom.classList.contains(SEARCH_OPEN_CLASS));
    view.destroy();
  });

  it('defines a rule that hides selection matches while the panel is open', () => {
    const view = createView();
    assert.match(allCss(), new RegExp(`\\.${SEARCH_OPEN_CLASS} \\.cm-selectionMatch\\s*\\{\\s*background-color:\\s*transparent`));
    view.destroy();
  });
});

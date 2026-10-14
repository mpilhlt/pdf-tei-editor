#!/usr/bin/env node

/**
 * Unit tests for the XML editor focus-mode CodeMirror extension.
 * @testCovers app/src/modules/codemirror/focus-mode.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { focusModeExtension, setFocusRangeEffect } from '../../../app/src/modules/codemirror/focus-mode.js';
import { EditorView } from '@codemirror/view';

const DOC = '<a><b>one</b><b>two</b><b>three</b></a>';

function makeState() {
  return EditorState.create({ doc: DOC, extensions: [focusModeExtension] });
}

/** Collects the dimmed ranges from the decorations facet */
function dimmedRanges(state) {
  const ranges = [];
  for (const source of state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? null : source;
    if (!set) continue;
    set.between(0, state.doc.length, (from, to) => ranges.push([from, to]));
  }
  return ranges;
}

describe('focus mode extension', () => {
  it('dims nothing without a focus range', () => {
    assert.deepStrictEqual(dimmedRanges(makeState()), []);
  });

  it('dims everything before and after the focused range', () => {
    const from = DOC.indexOf('<b>two');
    const to = from + '<b>two</b>'.length;
    const state = makeState().update({ effects: setFocusRangeEffect.of({ from, to }) }).state;
    assert.deepStrictEqual(dimmedRanges(state), [[0, from], [to, DOC.length]]);
  });

  it('keeps edits inside the focused range undimmed and clears on null', () => {
    const from = DOC.indexOf('<b>two');
    const to = from + '<b>two</b>'.length;
    let state = makeState().update({ effects: setFocusRangeEffect.of({ from, to }) }).state;
    state = state.update({ changes: { from: from + 3, insert: 'XX' } }).state;
    assert.deepStrictEqual(dimmedRanges(state), [[0, from], [to + 2, DOC.length + 2]]);
    state = state.update({ effects: setFocusRangeEffect.of(null) }).state;
    assert.deepStrictEqual(dimmedRanges(state), []);
  });
});

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

/** Collects decorations of the given class from the decorations facet as [from, to, class] */
function decorations(state) {
  const found = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue;
    source.between(0, state.doc.length, (from, to, value) => {
      found.push([from, to, value.spec.class]);
    });
  }
  return found;
}

const MULTILINE = 'l1\nl2 <b>one</b>\nl3 <b>two</b> tail\nl4\nl5';

function focused(doc, needle) {
  const from = doc.indexOf(needle);
  const to = from + needle.length;
  const state = EditorState.create({ doc, extensions: [focusModeExtension] });
  return { state: state.update({ effects: setFocusRangeEffect.of({ from, to }) }).state, from, to };
}

describe('focus mode extension', () => {
  it('adds no decorations without a focus range', () => {
    const state = EditorState.create({ doc: MULTILINE, extensions: [focusModeExtension] });
    assert.deepStrictEqual(decorations(state), []);
  });

  it('dims lines outside the range and the partial lines around it, and flags first and last line', () => {
    const { state, from, to } = focused(MULTILINE, '<b>two</b>');
    const lineStart = n => state.doc.line(n).from;
    const dimmed = decorations(state).filter(d => d[2] === 'cm-focus-dimmed');
    assert.deepStrictEqual(dimmed, [
      [lineStart(1), lineStart(1), 'cm-focus-dimmed'],
      [lineStart(2), lineStart(2), 'cm-focus-dimmed'],
      [lineStart(3), from, 'cm-focus-dimmed'],
      [to, state.doc.line(3).to, 'cm-focus-dimmed'],
      [lineStart(4), lineStart(4), 'cm-focus-dimmed'],
      [lineStart(5), lineStart(5), 'cm-focus-dimmed']
    ]);
    const flags = decorations(state).filter(d => d[2] !== 'cm-focus-dimmed').map(d => d[2]);
    assert.deepStrictEqual(flags, ['cm-focus-first', 'cm-focus-last']);
  });

  it('keeps edits inside the focused range undimmed and clears on null', () => {
    const { state, from } = focused(MULTILINE, '<b>two</b>');
    let next = state.update({ changes: { from: from + 3, insert: 'XX' } }).state;
    const dimmed = decorations(next).filter(d => d[2] === 'cm-focus-dimmed' && d[1] > d[0]);
    assert.strictEqual(dimmed[0][1], from);
    assert.strictEqual(dimmed[1][0], from + '<b>two</b>'.length + 2);
    next = next.update({ effects: setFocusRangeEffect.of(null) }).state;
    assert.deepStrictEqual(decorations(next), []);
  });
});

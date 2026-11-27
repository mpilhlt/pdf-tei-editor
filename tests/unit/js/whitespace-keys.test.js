#!/usr/bin/env node

/**
 * Tests for the whitespace commands of the visual annotation mode.
 *
 * @testCovers app/src/modules/codemirror/whitespace-keys.js
 */

/**
 * @import { Transaction } from '@codemirror/state'
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState, EditorSelection } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { insertNewlineKeepIndent, deleteWhitespaceBackward, indentLines, outdentLines } from '../../../app/src/modules/codemirror/whitespace-keys.js';

/**
 * Runs a command on a read-only state, as in the visual annotation mode.
 * @param {(target: {state: EditorState, dispatch: (tr: Transaction) => void}) => boolean} command
 * @param {string} doc
 * @param {EditorSelection} selection
 * @param {string} [unit]
 * @returns {{doc: string, head: number}}
 */
function run(command, doc, selection, unit = '  ') {
  let state = EditorState.create({ doc, selection, extensions: [EditorState.readOnly.of(true), indentUnit.of(unit)] });
  command({ state, dispatch: tr => { state = tr.state; } });
  return { doc: state.doc.toString(), head: state.selection.main.head };
}

describe('insertNewlineKeepIndent', () => {
  it('copies the indentation of the line verbatim', () => {
    const doc = '<p>\n \t  Alpha Beta</p>';
    const pos = doc.indexOf(' Beta');
    const result = run(insertNewlineKeepIndent, doc, EditorSelection.single(pos));
    assert.strictEqual(result.doc, '<p>\n \t  Alpha\n \t   Beta</p>');
    assert.strictEqual(result.head, pos + 5);
  });

  it('does not infer an indentation from the XML structure', () => {
    const result = run(insertNewlineKeepIndent, '<p><s>Alpha</s></p>', EditorSelection.single(6));
    assert.strictEqual(result.doc, '<p><s>\nAlpha</s></p>');
  });

  it('copies only the indentation before a cursor inside it', () => {
    const result = run(insertNewlineKeepIndent, '    Alpha', EditorSelection.single(2));
    assert.strictEqual(result.doc, '  \n    Alpha');
  });

  it('does not overwrite a selection', () => {
    const result = run(insertNewlineKeepIndent, '  Alpha Beta', EditorSelection.single(7, 8));
    assert.strictEqual(result.doc, '  Alpha Beta');
  });
});

describe('deleteWhitespaceBackward', () => {
  it('deletes a space or tab before the cursor', () => {
    assert.deepStrictEqual(run(deleteWhitespaceBackward, 'Alpha \tBeta', EditorSelection.single(7)), { doc: 'Alpha Beta', head: 6 });
  });

  it('deletes a line break before the cursor', () => {
    assert.deepStrictEqual(run(deleteWhitespaceBackward, 'Alpha\nBeta', EditorSelection.single(6)), { doc: 'AlphaBeta', head: 5 });
  });

  it('does not delete other text', () => {
    assert.strictEqual(run(deleteWhitespaceBackward, 'Alpha Beta', EditorSelection.single(5)).doc, 'Alpha Beta');
    assert.strictEqual(run(deleteWhitespaceBackward, 'Alpha', EditorSelection.single(0)).doc, 'Alpha');
  });

  it('deletes a selection of whitespace only', () => {
    assert.strictEqual(run(deleteWhitespaceBackward, 'Alpha \n  Beta', EditorSelection.single(5, 9)).doc, 'AlphaBeta');
    assert.strictEqual(run(deleteWhitespaceBackward, 'Alpha Beta', EditorSelection.single(4, 6)).doc, 'Alpha Beta');
  });
});

describe('indentLines / outdentLines', () => {
  it('indents each selected line by the indentation unit', () => {
    const result = run(indentLines, 'a\nb\nc', EditorSelection.single(0, 3));
    assert.strictEqual(result.doc, '  a\n  b\nc');
  });

  it('does not indent a line the selection ends at the start of', () => {
    const result = run(indentLines, 'a\nb', EditorSelection.single(0, 2));
    assert.strictEqual(result.doc, '  a\nb');
  });

  it('outdents by at most one unit of spaces, or a tab', () => {
    const result = run(outdentLines, '     a\n\t\tb\n c\nd', EditorSelection.single(0, 14));
    assert.strictEqual(result.doc, '   a\n\tb\nc\nd');
  });

  it('indents with the configured unit', () => {
    const result = run(indentLines, 'a', EditorSelection.single(0), '\t');
    assert.strictEqual(result.doc, '\ta');
  });
});

#!/usr/bin/env node

/**
 * Tests for splitting the XML element that contains a position into two elements.
 *
 * @testCovers app/src/modules/codemirror/split-element.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { xml } from '@codemirror/lang-xml';
import { findSplitTarget, splitElementAt } from '../../../app/src/modules/codemirror/split-element.js';

/**
 * Creates a parsed state from a document in which `|` marks the position.
 * @param {string} marked
 * @returns {{state: EditorState, pos: number}}
 */
function stateAt(marked) {
  const pos = marked.indexOf('|');
  const state = EditorState.create({ doc: marked.slice(0, pos) + marked.slice(pos + 1), extensions: [xml()] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return { state, pos };
}

/**
 * Splits at the marked position and returns the resulting document and the cursor, or null.
 * @param {string} marked
 * @param {{newLine?: boolean}} [options]
 * @returns {{doc: string, cursor: number}|null}
 */
function split(marked, options = {}) {
  const { state, pos } = stateAt(marked);
  const spec = splitElementAt(state, pos, options);
  if (!spec) return null;
  const tr = state.update(spec);
  return { doc: tr.state.doc.toString(), cursor: tr.state.selection.main.head };
}

describe('splitElementAt', () => {
  it('splits a training.segmentation body element in its text', () => {
    const result = split('<tei><text><body>Line one\n|Line two</body></text></tei>');
    assert.ok(result);
    assert.strictEqual(result.doc, '<tei><text><body>Line one\n</body><body>Line two</body></text></tei>');
    assert.strictEqual(result.doc.slice(result.cursor), 'Line two</body></text></tei>');
  });

  it('splits the innermost element and copies its attributes', () => {
    const result = split('<r><bibl><title level="a">First| part</title></bibl></r>');
    assert.strictEqual(result?.doc, '<r><bibl><title level="a">First</title><title level="a"> part</title></bibl></r>');
  });

  it('splits the parent between child elements', () => {
    const result = split('<r><listBibl><bibl>A</bibl>|<bibl>B</bibl></listBibl></r>');
    assert.strictEqual(result?.doc, '<r><listBibl><bibl>A</bibl></listBibl><listBibl><bibl>B</bibl></listBibl></r>');
  });

  it('does not copy xml:id to the second element', () => {
    const result = split('<r><p xml:id="p1" n="1">ab|cd</p></r>');
    assert.strictEqual(result?.doc, '<r><p xml:id="p1" n="1">ab</p><p n="1">cd</p></r>');
  });

  it('splits at the start and the end of the content', () => {
    assert.strictEqual(split('<r><p>|ab</p></r>')?.doc, '<r><p></p><p>ab</p></r>');
    assert.strictEqual(split('<r><p>ab|</p></r>')?.doc, '<r><p>ab</p><p></p></r>');
  });

  it('starts the second element on a new line, indented like the first one', () => {
    const result = split('<TEI>\n  <text>\n    <body n="1">One <lb/>|Two</body>\n  </text>\n</TEI>', { newLine: true });
    assert.strictEqual(result?.doc, '<TEI>\n  <text>\n    <body n="1">One <lb/></body>\n    <body n="1">Two</body>\n  </text>\n</TEI>');
    assert.strictEqual(result.doc.slice(result.cursor, result.cursor + 3), 'Two');
  });

  it('indents the new line like the line on which the element starts', () => {
    const result = split('<r>\n\t<front>A</front><body>B|C</body>\n</r>', { newLine: true });
    assert.strictEqual(result?.doc, '<r>\n\t<front>A</front><body>B</body>\n\t<body>C</body>\n</r>');
  });

  it('reports the tag name of the element', () => {
    const { state, pos } = stateAt('<r><note place="foot">x|y</note></r>');
    assert.strictEqual(findSplitTarget(state, pos)?.tagName, 'note');
  });

  it('refuses to split the root element', () => {
    assert.strictEqual(split('<r>a|b</r>'), null);
  });

  it('refuses positions inside markup', () => {
    assert.strictEqual(split('<r><p n="|1">ab</p></r>'), null);
    assert.strictEqual(split('<r><p>a<l|b/>b</p></r>'), null);
    assert.strictEqual(split('<r><p>ab</p|></r>'), null);
    assert.strictEqual(split('<r><p>a&am|p;b</p></r>'), null);
    assert.strictEqual(split('<r><p>a<!-- c|c -->b</p></r>'), null);
  });

  it('refuses positions outside the root element', () => {
    assert.strictEqual(split('<?xml version="1.0"?>|<r><p>a</p></r>'), null);
  });
});

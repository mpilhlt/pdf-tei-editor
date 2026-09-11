#!/usr/bin/env node

/**
 * Tests for xml-annotation-ops.js — pure editing helpers for the XML annotation
 * plugin. Regression coverage for issue #443 (tagging a partially-tagged
 * selection must not produce overlapping XML).
 *
 * @testCovers app/src/modules/codemirror/xml-annotation-ops.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

const { relocatePartialAnnotationTags } = await import('../../../app/src/modules/codemirror/xml-annotation-ops.js')
const { EditorState } = await import('@codemirror/state')
const { xml } = await import('@codemirror/lang-xml')

const TAGS = ['bibl', 'author', 'title', 'date']

/**
 * Builds an EditorState with the XML language and returns it plus the offsets of
 * a `[` … `]` marked selection in `marked` (the markers are stripped).
 * @param {string} marked
 * @returns {{ state: object, from: number, to: number }}
 */
function build(marked) {
  const from = marked.indexOf('[')
  const to = marked.indexOf(']') - 1
  const doc = marked.replace('[', '').replace(']', '')
  const state = EditorState.create({ doc, extensions: [xml()] })
  return { state, from, to }
}

describe('relocatePartialAnnotationTags', () => {
  it('returns null when the selection covers no annotation element only partially', () => {
    const { state, from, to } = build('<bibl><author>[Kellner], Der</author></bibl>')
    assert.strictEqual(relocatePartialAnnotationTags(state, from, to, TAGS), null)
  })

  it('moves a dangling close tag out of the selection (issue #443)', () => {
    // Selecting `Der "Giftschrank"` starts inside <author> and ends after </author>.
    const { state, from, to } = build('<bibl><author>Kellner, [Der</author> "Giftschrank"] more</bibl>')
    const result = relocatePartialAnnotationTags(state, from, to, TAGS)
    assert.deepStrictEqual(result, {
      prepend: '</author>',
      append: '',
      cleanedText: 'Der "Giftschrank"',
    })
  })

  it('moves a dangling open tag out of the selection', () => {
    // Selection starts before <title> and ends inside it.
    const { state, from, to } = build('<bibl>foo [bar <title level="a">baz] qux</title></bibl>')
    const result = relocatePartialAnnotationTags(state, from, to, TAGS)
    assert.deepStrictEqual(result, {
      prepend: '',
      append: '<title level="a">',
      cleanedText: 'bar baz',
    })
  })

  it('ignores an element the selection fully contains', () => {
    const { state, from, to } = build('<bibl>[x <author>Kellner</author> y]</bibl>')
    assert.strictEqual(relocatePartialAnnotationTags(state, from, to, TAGS), null)
  })

  it('ignores an enclosing element whose tags are both outside the selection', () => {
    const { state, from, to } = build('<bibl><author>Kel[lner, D]er</author></bibl>')
    assert.strictEqual(relocatePartialAnnotationTags(state, from, to, TAGS), null)
  })

  it('closes nested dangling elements innermost-first', () => {
    const { state, from, to } = build('<bibl><title level="a"><author>Kellner, [Der</author></title> "x"] y</bibl>')
    const result = relocatePartialAnnotationTags(state, from, to, TAGS)
    assert.deepStrictEqual(result, {
      prepend: '</author></title>',
      append: '',
      cleanedText: 'Der "x"',
    })
  })

  it('reopens nested dangling elements outermost-first', () => {
    const { state, from, to } = build('<bibl>foo [bar <title level="a"><author>baz] qux</author></title></bibl>')
    const result = relocatePartialAnnotationTags(state, from, to, TAGS)
    assert.deepStrictEqual(result, {
      prepend: '',
      append: '<title level="a"><author>',
      cleanedText: 'bar baz',
    })
  })
})

#!/usr/bin/env node

/**
 * Reads the shared stand-off fixtures with the JS modules and compares the result with the
 * expected digest, which the Python message indexer test (`test_messages_standoff_reader.py`)
 * compares with its own reading. Keeps both implementations in step.
 *
 * Set UPDATE_FIXTURES=1 to rewrite the expected digest from the JS result.
 *
 * @testCovers app/src/modules/unit-review.js
 * @testCovers app/src/modules/unit-comments.js
 * @testCovers app/src/modules/mentions.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { findUnits, readReviewData } from '../../../app/src/modules/unit-review.js';
import { readComments, buildThreads } from '../../../app/src/modules/unit-comments.js';
import { findMentions } from '../../../app/src/modules/mentions.js';

const FIXTURES = new URL('../fixtures/standoff/', import.meta.url);
const EXPECTED = new URL('messages-sample.expected.json', FIXTURES);

/** Texts for the mention token rule */
const MENTION_SAMPLES = [
  '@jdoe is "ibid." correct here?',
  'Mail me at a@b.org, not @nobody.',
  'Ask @j.doe-2, @x and @a_b. (@c)',
  '@@double @-dash @trailing. @trailing-',
  'Check the @type attribute and email@host'
];

/**
 * @param {Document} doc
 * @param {string} type
 * @returns {Element|null}
 */
function listOf(doc, type) {
  return Array.from(doc.getElementsByTagNameNS('*', 'listAnnotation')).find(el => el.getAttribute('type') === type) ?? null;
}

/**
 * Computes the digest of a fixture file.
 * @param {string} text
 * @returns {object}
 */
function digest(text) {
  const state = EditorState.create({ doc: text, extensions: [xml()] });
  const doc = new JSDOM(text, { contentType: 'application/xml' }).window.document;
  const review = readReviewData(listOf(doc, 'unit-review'));
  const auto = findUnits(state, null);
  const explicit = findUnits(state, review.unitPath);
  const comments = readComments(listOf(doc, 'unit-comment'));
  /** @param {Map<string, import('../../../app/src/modules/unit-review.js').Mark>} map */
  const marks = map => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    units_auto: { path: auto.path, fingerprints: auto.units.map(u => u.fingerprint) },
    units_explicit: { path: explicit.path, fingerprints: explicit.units.map(u => u.fingerprint) },
    review: {
      unitPath: review.unitPath,
      reviewers: [...review.reviewers.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(r => ({ id: r.id, name: r.name, isLlm: r.isLlm, when: r.when, marks: marks(r.marks), was: marks(r.was) }))
    },
    comments,
    threads: buildThreads(comments).map(t => ({ id: t.root.id, replies: t.replies.map(r => r.id), status: t.status })),
    mentions: MENTION_SAMPLES.map(sample => [sample, findMentions(sample)])
  };
}

describe('shared stand-off fixtures', () => {
  it('match the expected digest', () => {
    const actual = digest(readFileSync(new URL('messages-sample.tei.xml', FIXTURES), 'utf8'));
    if (process.env.UPDATE_FIXTURES) writeFileSync(EXPECTED, JSON.stringify(actual, null, 2) + '\n');
    const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);
  });
});

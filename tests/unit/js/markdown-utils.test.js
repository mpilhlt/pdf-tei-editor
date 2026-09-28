#!/usr/bin/env node

/**
 * Unit tests for markdown-utils.js's heading-anchor line lookup.
 * @testCovers app/src/modules/markdown-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { findHeadingLineForAnchor } from '../../../app/src/modules/markdown-utils.js';

const DOC = `# Guidelines

Some intro text.

## Data correction

Explains how to correct data.

## Formatting

Explains formatting.
`;

describe('findHeadingLineForAnchor', () => {
  it('finds the 1-based line of the heading whose slug matches the anchor', () => {
    assert.strictEqual(findHeadingLineForAnchor(DOC, 'data-correction'), 5);
    assert.strictEqual(findHeadingLineForAnchor(DOC, 'formatting'), 9);
  });

  it('returns null when no heading matches', () => {
    assert.strictEqual(findHeadingLineForAnchor(DOC, 'nonexistent'), null);
  });

  it('matches the same slug algorithm createMarkdownRenderer() uses to id-tag headings (lowercase, strip punctuation, hyphenate spaces)', () => {
    const doc = '# A Title, With Punctuation!\n';
    assert.strictEqual(findHeadingLineForAnchor(doc, 'a-title-with-punctuation'), 1);
  });

  it('ignores non-ATX-heading lines starting with #', () => {
    const doc = '#not-a-heading\n## Data correction\n';
    assert.strictEqual(findHeadingLineForAnchor(doc, 'not-a-heading'), null);
    assert.strictEqual(findHeadingLineForAnchor(doc, 'data-correction'), 2);
  });
});

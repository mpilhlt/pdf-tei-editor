#!/usr/bin/env node

/**
 * Unit tests for markdown-utils.js's heading extraction and heading-anchor line lookup.
 * @testCovers app/src/modules/markdown-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createMarkdownRenderer, extractHeadings, findHeadingLineForAnchor, headingAnchor } from '../../../app/src/modules/markdown-utils.js';

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

describe('extractHeadings', () => {
  const md = createMarkdownRenderer();

  it('returns ATX and setext headings in document order with their levels', () => {
    const doc = '# Guide\n\nIntro\n\n## Data correction\n\n### Names\n\nSetext heading\n--------------\n';
    assert.deepStrictEqual(
      extractHeadings(md, doc).map(h => [h.level, h.text]),
      [[1, 'Guide'], [2, 'Data correction'], [3, 'Names'], [2, 'Setext heading']]
    );
  });

  it('ignores lines starting with # inside fenced code blocks', () => {
    const doc = '# Guide\n\n```bash\n# a shell comment\n```\n\n## Next\n';
    assert.deepStrictEqual(extractHeadings(md, doc).map(h => h.text), ['Guide', 'Next']);
  });

  it('strips inline markup from the text but uses the source text for the anchor, like the renderer', () => {
    const [heading] = extractHeadings(md, '## The `<bibl>` element, **in detail**\n');
    assert.strictEqual(heading.text, 'The <bibl> element, in detail');
    assert.strictEqual(heading.anchor, headingAnchor('The `<bibl>` element, **in detail**'));
    const html = md.render('## The `<bibl>` element, **in detail**\n');
    assert.ok(html.includes(`id="${heading.anchor}"`), html);
  });

  it('counts occurrences of headings sharing an anchor', () => {
    const doc = '## Examples\n\n## Other\n\n## Examples\n';
    assert.deepStrictEqual(extractHeadings(md, doc).map(h => [h.anchor, h.occurrence]), [
      ['examples', 0], ['other', 0], ['examples', 1]
    ]);
  });

  it('returns an empty list for a document without headings', () => {
    assert.deepStrictEqual(extractHeadings(md, 'Just text.\n'), []);
  });
});

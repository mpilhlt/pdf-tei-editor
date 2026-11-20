#!/usr/bin/env node

/**
 * Unit tests for the annotation guide window URLs and the lookup of guide URLs among the declared guide files.
 * @testCovers app/src/modules/guide-links.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { findGuide, guideUrlAtRef, guideWindowUrl, isCommitRef, parseGuideWindowUrl } from '../../../app/src/modules/guide-links.js';

const SHA = '9c3950228b7cf9e43d95f4bd52fb5ce18add3cff';

/** @type {import('../../../app/src/modules/api-client-v1.js').AnnotationGuideItem[]} */
const GUIDES = [
  {
    id: 'fossil-guidelines',
    url: 'https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md',
    url_template: 'https://github.com/mpilhlt/fossil/blob/{ref}/docs/guidelines.md',
    sections: []
  },
  { id: 'pad', url: 'https://pad.example.org/abc/download', url_template: null, sections: [] }
];

describe('guideWindowUrl / parseGuideWindowUrl', () => {
  it('builds and parses guide, ref and anchor', () => {
    const url = guideWindowUrl('fossil-guidelines', 'citation-model', { ref: SHA, origin: 'http://host' });
    assert.strictEqual(url, `http://host/guide/fossil-guidelines?ref=${SHA}#citation-model`);
    assert.deepStrictEqual(parseGuideWindowUrl(url), { id: 'fossil-guidelines', anchor: 'citation-model', ref: SHA });
  });

  it('parses the list of guides and rejects other URLs', () => {
    assert.deepStrictEqual(parseGuideWindowUrl('/guide/'), { id: '', anchor: '', ref: '' });
    assert.deepStrictEqual(parseGuideWindowUrl('/guide'), { id: '', anchor: '', ref: '' });
    assert.strictEqual(parseGuideWindowUrl('/manual/index'), null);
    assert.strictEqual(parseGuideWindowUrl('/guide/a/b'), null);
  });
});

describe('findGuide', () => {
  it('finds the configured URL', () => {
    const match = findGuide(GUIDES, 'https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#citation-model');
    assert.strictEqual(match?.guide.id, 'fossil-guidelines');
    assert.strictEqual(match?.ref, '');
    assert.strictEqual(match?.anchor, 'citation-model');
    assert.strictEqual(findGuide(GUIDES, 'https://pad.example.org/abc/download')?.guide.id, 'pad');
  });

  it('finds the same file at a commit', () => {
    const match = findGuide(GUIDES, `https://github.com/mpilhlt/fossil/blob/${SHA}/docs/guidelines.md#data-correction`);
    assert.strictEqual(match?.guide.id, 'fossil-guidelines');
    assert.strictEqual(match?.ref, SHA);
  });

  it('does not match other files, repositories or refs that are not commits', () => {
    assert.strictEqual(findGuide(GUIDES, `https://github.com/mpilhlt/fossil/blob/${SHA}/docs/guidelines-llm.md`), null);
    assert.strictEqual(findGuide(GUIDES, `https://github.com/other/fossil/blob/${SHA}/docs/guidelines.md`), null);
    assert.strictEqual(findGuide(GUIDES, 'https://github.com/mpilhlt/fossil/blob/devel/docs/guidelines.md'), null);
    assert.strictEqual(findGuide(GUIDES, `https://github.com/mpilhlt/fossil/blob/a/${SHA}/docs/guidelines.md`), null);
  });
});

describe('guideUrlAtRef', () => {
  it('puts a commit into the template, and keeps the configured URL otherwise', () => {
    assert.strictEqual(guideUrlAtRef(GUIDES[0], SHA), `https://github.com/mpilhlt/fossil/blob/${SHA}/docs/guidelines.md`);
    assert.strictEqual(guideUrlAtRef(GUIDES[0], ''), GUIDES[0].url);
    assert.strictEqual(guideUrlAtRef(GUIDES[0], '../evil'), GUIDES[0].url);
    assert.strictEqual(guideUrlAtRef(GUIDES[1], SHA), GUIDES[1].url);
    assert.strictEqual(isCommitRef('abc1234'), true);
    assert.strictEqual(isCommitRef('main'), false);
  });
});

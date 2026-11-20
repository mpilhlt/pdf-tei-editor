#!/usr/bin/env node

/**
 * Unit tests for the user manual links (GitHub blob URLs of files in docs/).
 * @testCovers app/src/modules/manual-links.js
 * @testCovers app/src/modules/manual-viewer.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { manualUrl, manualWindowUrl, parseManualUrl, parseManualWindowUrl } from '../../../app/src/modules/manual-links.js';
import { resolveManualPath } from '../../../app/src/modules/manual-viewer.js';

describe('parseManualUrl', () => {
  it('parses the page and anchor of a blob URL of a docs file', () => {
    assert.deepStrictEqual(
      parseManualUrl('https://github.com/mpilhlt/pdf-tei-editor/blob/9c3950228b7cf9e43d95f4bd52fb5ce18add3cff/docs/user-manual/access-tokens.md#using-a-token'),
      { path: 'user-manual/access-tokens.md', anchor: 'using-a-token' }
    );
    assert.deepStrictEqual(
      parseManualUrl('https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/index.md'),
      { path: 'index.md', anchor: '' }
    );
  });

  it('rejects URLs that are not manual pages', () => {
    for (const url of [
      'https://github.com/mpilhlt/pdf-tei-editor/blob/main/README.md#key-features',
      'https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/images/logo.png',
      'https://github.com/mpilhlt/other-repo/blob/main/docs/index.md',
      'https://github.com/mpilhlt/pdf-tei-editor/edit/devel/docs/index.md',
      'https://example.org/mpilhlt/pdf-tei-editor/blob/main/docs/index.md',
      'user-manual/cli.md',
      ''
    ]) {
      assert.strictEqual(parseManualUrl(url), null, url);
    }
  });
});

describe('manualUrl', () => {
  it('builds a blob URL that parseManualUrl reads back', () => {
    const url = manualUrl('user-manual/cli.md', 'personal-access-tokens', 'v0.82.0');
    assert.strictEqual(url, 'https://github.com/mpilhlt/pdf-tei-editor/blob/v0.82.0/docs/user-manual/cli.md#personal-access-tokens');
    assert.deepStrictEqual(parseManualUrl(url), { path: 'user-manual/cli.md', anchor: 'personal-access-tokens' });
  });

  it('defaults to main and omits an empty anchor', () => {
    assert.strictEqual(manualUrl('/index.md'), 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/index.md');
  });
});

describe('manualWindowUrl', () => {
  it('builds clean window URLs', () => {
    assert.strictEqual(manualWindowUrl('index.md'), '/manual/');
    assert.strictEqual(manualWindowUrl('/user-manual/review-workflow.md', 'unit-review'), '/manual/user-manual/review-workflow#unit-review');
    assert.strictEqual(
      manualWindowUrl('plugins/grobid/docs/llm-review-tutorial.md', '', { lang: 'de', origin: 'https://pte.example.org' }),
      'https://pte.example.org/manual/plugins/grobid/docs/llm-review-tutorial?lang=de'
    );
  });
});

describe('parseManualWindowUrl', () => {
  it('parses page, anchor and language', () => {
    assert.deepStrictEqual(parseManualWindowUrl('https://pte.example.org/manual/user-manual/review-workflow?dev#unit-review'),
      { path: 'user-manual/review-workflow.md', anchor: 'unit-review', lang: '' });
    assert.deepStrictEqual(parseManualWindowUrl('/manual/'), { path: 'index.md', anchor: '', lang: '' });
    assert.deepStrictEqual(parseManualWindowUrl('/manual'), { path: 'index.md', anchor: '', lang: '' });
    assert.deepStrictEqual(parseManualWindowUrl('/manual/plugins/grobid/docs/t.md?lang=de'), { path: 'plugins/grobid/docs/t.md', anchor: '', lang: 'de' });
  });

  it('round-trips with manualWindowUrl', () => {
    const url = manualWindowUrl('user-manual/access-tokens.md', 'using-a-token', { lang: 'en' });
    assert.deepStrictEqual(parseManualWindowUrl(url), { path: 'user-manual/access-tokens.md', anchor: 'using-a-token', lang: 'en' });
  });

  it('rejects other URLs and other origins', () => {
    assert.strictEqual(parseManualWindowUrl('/manuals/x'), null);
    assert.strictEqual(parseManualWindowUrl('/docs/user-manual/x.md'), null);
    assert.strictEqual(parseManualWindowUrl('https://other.org/manual/x', 'https://pte.example.org'), null);
    assert.ok(parseManualWindowUrl('https://pte.example.org/manual/x', 'https://pte.example.org'));
  });
});

describe('resolveManualPath', () => {
  it('resolves links relative to the current page or to docs/', () => {
    assert.deepStrictEqual(resolveManualPath('user-manual/a.md', 'b.md#x'), { path: 'user-manual/b.md', anchor: 'x' });
    assert.deepStrictEqual(resolveManualPath('user-manual/a.md', '../index.md'), { path: 'index.md', anchor: '' });
    assert.deepStrictEqual(resolveManualPath('index.md', './user-manual/a.md'), { path: 'user-manual/a.md', anchor: '' });
    assert.deepStrictEqual(resolveManualPath('user-manual/a.md', '/development/x.md'), { path: 'development/x.md', anchor: '' });
    assert.deepStrictEqual(resolveManualPath('user-manual/a.md', '#top'), { path: 'user-manual/a.md', anchor: 'top' });
  });
});

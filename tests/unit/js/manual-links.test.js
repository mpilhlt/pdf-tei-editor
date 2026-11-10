#!/usr/bin/env node

/**
 * Unit tests for the user manual links (GitHub blob URLs of files in docs/).
 * @testCovers app/src/modules/manual-links.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { manualUrl, parseManualUrl } from '../../../app/src/modules/manual-links.js';

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

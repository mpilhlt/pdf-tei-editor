/**
 * Unit tests for git-forge URL helpers.
 *
 * @testCovers app/src/modules/git-forge-urls.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { blobUrlToRawUrl } from '../../../app/src/modules/git-forge-urls.js';

describe('blobUrlToRawUrl', () => {
  it('converts a GitHub blob URL to raw.githubusercontent.com', () => {
    const url = 'https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md';
    assert.strictEqual(
      blobUrlToRawUrl(url),
      'https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md'
    );
  });

  it('converts a GitHub blob URL with a commit SHA', () => {
    const sha = 'a'.repeat(40);
    const url = `https://github.com/mpilhlt/fossil/blob/${sha}/docs/guidelines.md`;
    assert.strictEqual(
      blobUrlToRawUrl(url),
      `https://raw.githubusercontent.com/mpilhlt/fossil/${sha}/docs/guidelines.md`
    );
  });

  it('converts a GitLab blob URL to its -/raw/ equivalent', () => {
    const url = 'https://gitlab.com/group/project/-/blob/main/docs/guidelines.md';
    assert.strictEqual(
      blobUrlToRawUrl(url),
      'https://gitlab.com/group/project/-/raw/main/docs/guidelines.md'
    );
  });

  it('converts a self-hosted GitLab blob URL with a nested group path', () => {
    const url = 'https://gitlab.example.org/group/subgroup/project/-/blob/main/docs/guide.md';
    assert.strictEqual(
      blobUrlToRawUrl(url),
      'https://gitlab.example.org/group/subgroup/project/-/raw/main/docs/guide.md'
    );
  });

  it('returns an unrecognized URL unchanged', () => {
    const url = 'https://pad.gwdg.de/s/abc123/download';
    assert.strictEqual(blobUrlToRawUrl(url), url);
  });

  it('returns a malformed/non-absolute URL unchanged instead of throwing', () => {
    assert.strictEqual(blobUrlToRawUrl(''), '');
    assert.strictEqual(blobUrlToRawUrl('docs/guidelines.md'), 'docs/guidelines.md');
  });

  it('returns a github.com URL that is not a blob-shape path unchanged', () => {
    const url = 'https://github.com/owner/repo';
    assert.strictEqual(blobUrlToRawUrl(url), url);
  });
});

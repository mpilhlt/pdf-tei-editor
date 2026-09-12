#!/usr/bin/env node

/**
 * Verifies that ignoreLineWhitespaceInDiff() resolves leading/trailing
 * whitespace-only line differences in favor of the target text, that
 * ignoreInterTagWhitespaceInDiff() resolves inserted/removed linebreaks and
 * indentation between tags, and that normalizeXmlWhitespaceForDiff() combines
 * both while preserving genuine content differences.
 *
 * @testCovers app/src/modules/diff-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ignoreLineWhitespaceInDiff,
  ignoreInterTagWhitespaceInDiff,
  normalizeXmlWhitespaceForDiff
} from '../../../app/src/modules/diff-utils.js';

describe('ignoreLineWhitespaceInDiff', () => {
  it('rewrites lines that only differ by leading/trailing whitespace', () => {
    const reference = 'line1\n  line2  \nline3\n';
    const target = 'line1\nline2\nline3\n';
    assert.strictEqual(ignoreLineWhitespaceInDiff(reference, target), target);
  });

  it('preserves genuine content differences', () => {
    const reference = '  line1\nline2-old\nline3  \n';
    const target = 'line1\nline2-new\nline3\n';
    const result = ignoreLineWhitespaceInDiff(reference, target);
    assert.strictEqual(result, 'line1\nline2-old\nline3\n');
  });

  it('leaves lines only present in the reference untouched', () => {
    const reference = 'line1\nline2\nremoved-line\n';
    const target = 'line1\nline2\n';
    const result = ignoreLineWhitespaceInDiff(reference, target);
    assert.strictEqual(result, 'line1\nline2\nremoved-line\n');
  });

  it('drops nothing but leaves lines only present in target out of the result', () => {
    const reference = 'line1\n';
    const target = 'line1\nadded-line\n';
    const result = ignoreLineWhitespaceInDiff(reference, target);
    assert.strictEqual(result, 'line1\n');
  });

  it('is a no-op when there are no differences', () => {
    const text = 'line1\nline2\n';
    assert.strictEqual(ignoreLineWhitespaceInDiff(text, text), text);
  });
});

describe('ignoreInterTagWhitespaceInDiff', () => {
  it('rewrites an inserted linebreak between tags to match the target', () => {
    const reference = '<a>\n  <b/>\n</a>';
    const target = '<a><b/></a>';
    assert.strictEqual(ignoreInterTagWhitespaceInDiff(reference, target), target);
  });

  it('rewrites a removed linebreak between tags to match the target', () => {
    const reference = '<a><b/></a>';
    const target = '<a>\n  <b/>\n</a>';
    assert.strictEqual(ignoreInterTagWhitespaceInDiff(reference, target), target);
  });

  it('does not touch whitespace inside element text content', () => {
    const reference = '<p>hello\nworld</p>';
    const target = '<p>hello world</p>';
    assert.strictEqual(ignoreInterTagWhitespaceInDiff(reference, target), reference);
  });

  it('preserves genuine content differences alongside reformatted whitespace', () => {
    const reference = '<a>\n  <b>old</b>\n</a>';
    const target = '<a><b>new</b></a>';
    const result = ignoreInterTagWhitespaceInDiff(reference, target);
    assert.strictEqual(result, '<a><b>old</b></a>');
  });
});

describe('normalizeXmlWhitespaceForDiff', () => {
  it('normalizes a pretty-printed document to match a compact one with the same content', () => {
    const reference = '<a>\n  <b>text</b>\n</a>';
    const target = '<a><b>text</b></a>';
    assert.strictEqual(normalizeXmlWhitespaceForDiff(reference, target), target);
  });

  it('still surfaces genuine content changes alongside reformatted whitespace', () => {
    const reference = '<a>\n  <b>old</b>\n</a>';
    const target = '<a><b>new</b></a>';
    const result = normalizeXmlWhitespaceForDiff(reference, target);
    assert.strictEqual(result, '<a><b>old</b></a>');
  });
});

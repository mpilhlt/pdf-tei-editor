#!/usr/bin/env node

/**
 * Verifies that ignoreLineWhitespaceInDiff() resolves leading/trailing
 * whitespace-only line differences in favor of the target text, while
 * preserving genuine content differences.
 *
 * @testCovers app/src/modules/diff-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ignoreLineWhitespaceInDiff } from '../../../app/src/modules/diff-utils.js';

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

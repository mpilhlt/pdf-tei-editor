#!/usr/bin/env node

/**
 * Unit tests for the description of LLM corrections in the OCR result.
 * @testCovers app/src/modules/ocr-llm-corrections.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { describeLlmCorrections } from '../../../app/src/modules/ocr-llm-corrections.js';

/**
 * @param {number} count
 * @returns {Array<{page: number, old: string, new: string, rationale: string}>}
 */
const make = count => Array.from({ length: count }, (_, i) => ({ page: i, old: `o${i}`, new: `n${i}`, rationale: 'r' }));

describe('describeLlmCorrections', () => {
  it('describes a single correction in the singular', () => {
    assert.strictEqual(describeLlmCorrections(make(1)), 'The language model made 1 correction: “o0” → “n0”');
  });

  it('lists five corrections and counts the rest', () => {
    assert.strictEqual(
      describeLlmCorrections(make(7)),
      'The language model made 7 corrections: “o0” → “n0”, “o1” → “n1”, “o2” → “n2”, “o3” → “n3”, “o4” → “n4” and 2 more'
    );
  });

  it('returns an empty string without corrections', () => {
    assert.strictEqual(describeLlmCorrections([]), '');
  });
});

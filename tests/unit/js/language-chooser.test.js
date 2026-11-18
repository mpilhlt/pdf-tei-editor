#!/usr/bin/env node

/**
 * Tests for the generic language chooser used by the OCR options dialog.
 *
 * @testCovers app/src/modules/language-chooser.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { languageName, normalizeLanguageCode, matchLanguages } from '../../../app/src/modules/language-chooser.js';

describe('language chooser', () => {
  it('normalizes language codes like the backend', () => {
    assert.strictEqual(normalizeLanguageCode('DE'), 'de');
    assert.strictEqual(normalizeLanguageCode('en_us'), 'en-US');
    assert.strictEqual(normalizeLanguageCode('zh-hans'), 'zh-Hans');
  });

  it('returns display names, with fallbacks for languages browsers do not know', () => {
    assert.strictEqual(languageName('de'), 'German');
    assert.strictEqual(languageName('grc'), 'Ancient Greek');
    assert.strictEqual(languageName('qqq'), 'qqq');
  });

  it('matches candidate languages against the offered ones', () => {
    const offered = ['de', 'en', 'zh-Hans'];
    assert.deepStrictEqual(matchLanguages(['en-US', null, 'und', 'fr', 'DE', 'en'], offered), ['en', 'de']);
    assert.deepStrictEqual(matchLanguages(['zh-hans'], offered), ['zh-Hans']);
    assert.deepStrictEqual(matchLanguages([], offered), []);
  });
});

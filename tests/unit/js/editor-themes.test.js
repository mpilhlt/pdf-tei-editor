#!/usr/bin/env node

/**
 * @testCovers app/src/modules/codemirror/editor-themes.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

const { THEMES, getTheme } = await import('../../../app/src/modules/codemirror/editor-themes.js');

describe('editor-themes', () => {
  it('every theme has a readOnlyBackground string', () => {
    for (const theme of THEMES) {
      assert.strictEqual(
        typeof theme.readOnlyBackground, 'string',
        `theme "${theme.id}" is missing readOnlyBackground`
      );
      assert.match(
        theme.readOnlyBackground, /^#[0-9a-f]{6}$/i,
        `theme "${theme.id}" readOnlyBackground is not a 6-digit hex color`
      );
    }
  });

  it('getTheme falls back to default for unknown id', () => {
    const t = getTheme('nonexistent');
    assert.strictEqual(t.id, 'default');
  });
});

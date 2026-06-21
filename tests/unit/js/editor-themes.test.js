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

  it('default theme has amber read-only background', () => {
    assert.strictEqual(getTheme('default').readOnlyBackground, '#f8e8b7');
  });

  it('dark theme has dark-amber read-only background', () => {
    assert.strictEqual(getTheme('dark').readOnlyBackground, '#2e2a00');
  });

  it('colorBlind theme has amber read-only background', () => {
    assert.strictEqual(getTheme('colorBlind').readOnlyBackground, '#f8e8b7');
  });

  it('highContrast theme has bright-yellow read-only background', () => {
    assert.strictEqual(getTheme('highContrast').readOnlyBackground, '#ffe566');
  });

  it('getTheme falls back to default for unknown id', () => {
    const t = getTheme('nonexistent');
    assert.strictEqual(t.id, 'default');
  });
});

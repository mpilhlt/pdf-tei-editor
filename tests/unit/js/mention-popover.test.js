#!/usr/bin/env node

/**
 * Unit test: picking a name from the mention list keeps the popover open (#697).
 * @testCovers app/src/modules/unit-review-popover.js
 * @testCovers app/src/modules/mention-autocomplete.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
Object.assign(global, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  MouseEvent: dom.window.MouseEvent
});
const { openCommentPrompt } = await import('../../../app/src/modules/unit-review-popover.js');

describe('mention autocomplete in a popover', () => {
  it('inserts the mention without closing the popover', async () => {
    let done = /** @type {string|null|undefined} */ (undefined);
    openCommentPrompt({ left: 10, bottom: 10 }, 'Comment', '', c => { done = c; }, {
      testid: 'prompt',
      mentions: [{ id: 'jdoe', name: 'Jane Doe' }]
    });
    // the outside-click listener is added deferred
    await new Promise(resolve => setTimeout(resolve, 0));
    const prompt = document.querySelector('[data-testid="prompt"]');
    const input = /** @type {HTMLInputElement} */ (prompt?.querySelector('input'));
    input.value = '@j';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new dom.window.Event('input'));
    const option = /** @type {HTMLElement} */ (document.querySelector('.mention-list [role="option"]'));
    assert.ok(option, 'mention list shown');
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.ok(prompt?.isConnected, 'popover still open');
    assert.strictEqual(done, undefined, 'prompt not finished');
    assert.strictEqual(input.value, '@jdoe ');
    // a click elsewhere still closes it
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    assert.ok(!prompt?.isConnected, 'popover closed by outside click');
    assert.strictEqual(done, null);
  });
});

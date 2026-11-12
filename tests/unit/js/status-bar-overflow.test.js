#!/usr/bin/env node

/**
 * Unit tests for the status bar's priority-based overflow hiding.
 * jsdom has no layout, so widths are mocked via getBoundingClientRect.
 * @testCovers app/src/modules/panels/status-bar.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.customElements = dom.window.customElements;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = callback => setTimeout(callback, 0);

const { StatusBar } = await import('../../../app/src/modules/panels/status-bar.js');

/**
 * Makes an element report a fixed width, or 0 while it is hidden by overflow
 * @param {HTMLElement} element
 * @param {number} width
 * @returns {HTMLElement}
 */
function withWidth(element, width) {
  element.getBoundingClientRect = () => {
    const w = element.hasAttribute('data-overflow-hidden') ? 0 : width;
    return /** @type {DOMRect} */ ({ width: w, height: 20, top: 0, left: 0, right: w, bottom: 20, x: 0, y: 0 });
  };
  return element;
}

/**
 * Creates a status bar of the given width with the right-hand widgets of the XML editor
 * @param {number} barWidth
 * @returns {{bar: StatusBar, indent: HTMLElement, separator: HTMLElement, cursor: HTMLElement, navigation: HTMLElement, reviewMeter: HTMLElement, commentMeter: HTMLElement}}
 */
function createBar(barWidth) {
  const bar = /** @type {StatusBar} */ (document.createElement('status-bar'));
  withWidth(bar, barWidth);
  document.body.appendChild(bar);
  const indent = withWidth(document.createElement('span'), 100);
  const separator = withWidth(document.createElement('status-separator'), 10);
  const cursor = withWidth(document.createElement('span'), 80);
  const navigation = withWidth(document.createElement('span'), 120);
  const reviewMeter = withWidth(document.createElement('span'), 120);
  const commentMeter = withWidth(document.createElement('span'), 60);
  bar.add(navigation, 'center', 5);
  bar.add(indent, 'right', -2);
  bar.add(separator, 'right', -2);
  bar.add(cursor, 'right', -10);
  bar.add(reviewMeter, 'right', 4);
  bar.add(commentMeter, 'right', 6);
  return { bar, indent, separator, cursor, navigation, reviewMeter, commentMeter };
}

/** @param {HTMLElement} element */
const hidden = element => element.hasAttribute('data-overflow-hidden');

describe('StatusBar overflow', () => {
  it('shows all widgets when they fit', () => {
    const w = createBar(1000);
    w.bar.checkAndResolveOverflow();
    assert.deepStrictEqual([w.indent, w.separator, w.cursor, w.navigation, w.reviewMeter, w.commentMeter].map(hidden), [false, false, false, false, false, false]);
  });

  it('hides the cursor position first, then indentation and its separator, then the review meter before the navigation', () => {
    const w = createBar(500);
    w.bar.checkAndResolveOverflow();
    assert.strictEqual(hidden(w.cursor), true);
    assert.strictEqual(hidden(w.indent), false);
    assert.strictEqual(hidden(w.separator), true, 'separator goes with the widget after it');
    assert.strictEqual(hidden(w.reviewMeter), false);

    const narrow = createBar(400);
    narrow.bar.checkAndResolveOverflow();
    assert.strictEqual(hidden(narrow.cursor), true);
    assert.strictEqual(hidden(narrow.indent), true);
    assert.strictEqual(hidden(narrow.separator), true);
    assert.strictEqual(hidden(narrow.reviewMeter), false);
    assert.strictEqual(hidden(narrow.navigation), false);

    const narrower = createBar(260);
    narrower.bar.checkAndResolveOverflow();
    assert.strictEqual(hidden(narrower.reviewMeter), true);
    assert.strictEqual(hidden(narrower.navigation), false);
    assert.strictEqual(hidden(narrower.commentMeter), false);
  });

  it('shows hidden widgets again when space becomes available', () => {
    const w = createBar(300);
    w.bar.checkAndResolveOverflow();
    assert.strictEqual(hidden(w.indent), true);
    withWidth(w.bar, 1000);
    w.bar.checkAndResolveOverflow();
    w.bar.checkAndResolveOverflow();
    assert.deepStrictEqual([w.indent, w.separator, w.cursor].map(hidden), [false, false, false]);
  });

  it('hides a separator whose preceding widget has no width', () => {
    const w = createBar(1000);
    withWidth(w.indent, 0);
    w.bar.checkAndResolveOverflow();
    assert.strictEqual(hidden(w.separator), true);
  });

  it('hides a separator whose following widget is hidden', () => {
    const w = createBar(1000);
    withWidth(w.cursor, 0);
    w.bar.checkAndResolveOverflow();
    assert.strictEqual(hidden(w.separator), true);
    assert.strictEqual(hidden(w.indent), false);
  });

  it('is exported as StatusBar', () => {
    assert.strictEqual(typeof StatusBar, 'function');
  });
});

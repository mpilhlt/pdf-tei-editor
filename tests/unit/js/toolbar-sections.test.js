#!/usr/bin/env node

/**
 * Unit tests for toolbar sections and for the separation of display order and overflow priority.
 * @testCovers app/src/modules/panels/tool-bar.js
 * @testCovers app/src/modules/panels/base-panel.js
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
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = callback => setTimeout(callback, 0);

const { ToolBar } = await import('../../../app/src/modules/panels/tool-bar.js');
const { resolveContributions } = await import('../../../app/src/modules/panels/base-panel.js');

/** @returns {ToolBar} */
function createToolbar() {
  const toolbar = /** @type {ToolBar} */ (document.createElement('tool-bar'));
  document.body.appendChild(toolbar);
  return toolbar;
}

/**
 * @param {string} name
 * @returns {HTMLElement}
 */
function widget(name) {
  const el = document.createElement('span');
  el.setAttribute('name', name);
  return el;
}

/**
 * Names of the visible toolbar children, `|` for a section separator
 * @param {ToolBar} toolbar
 * @returns {string}
 */
function layout(toolbar) {
  return Array.from(toolbar.children)
    .filter(el => el instanceof HTMLElement && el.style.display !== 'none' && !el.hasAttribute('data-overflow-hidden'))
    .map(el => el.getAttribute('name') ?? (el.tagName === 'STATUS-SEPARATOR' ? '|' : el.tagName.toLowerCase()))
    .join(' ');
}

/** Lets the MutationObserver callbacks run */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ToolBar sections', () => {
  it('orders widgets by section and order, independent of the call order', () => {
    const toolbar = createToolbar();
    toolbar.add(widget('left'), 100);
    toolbar.defineSections(['review', 'transfer', 'plugins']);
    toolbar.addToSection('plugins', widget('xsl'), 50.5);
    toolbar.addToSection('review', widget('review'), 93, 1);
    toolbar.addToSection('transfer', widget('upload'), 3, 0);
    toolbar.addToSection('plugins', widget('wizard'), 51.5);
    toolbar.addToSection('review', widget('history'), 1, 2);
    toolbar.addToSection('transfer', widget('download'), 2, -1);
    assert.strictEqual(layout(toolbar), 'left history review | upload download | wizard xsl');
  });

  it('keeps the overflow priority separate from the order', () => {
    const toolbar = createToolbar();
    toolbar.defineSections(['review']);
    const history = widget('history');
    toolbar.addToSection('review', history, 1, 2);
    assert.strictEqual(history.dataset.priority, '1');
    assert.strictEqual(history.dataset.sectionOrder, '2');
  });

  it('hides a separator while one of its sides has no visible widget', async () => {
    const toolbar = createToolbar();
    toolbar.defineSections(['review', 'transfer', 'plugins']);
    const history = widget('history');
    toolbar.addToSection('transfer', widget('upload'));
    assert.strictEqual(layout(toolbar), 'upload', 'empty neighbouring sections');

    toolbar.addToSection('review', history);
    assert.strictEqual(layout(toolbar), 'history | upload');

    history.style.display = 'none';
    await flush();
    assert.strictEqual(layout(toolbar), 'upload', 'hidden widget');

    history.style.display = '';
    const wizard = widget('wizard');
    toolbar.addToSection('plugins', wizard);
    assert.strictEqual(layout(toolbar), 'history | upload | wizard');

    wizard.setAttribute('data-overflow-hidden', '');
    await flush();
    assert.strictEqual(layout(toolbar), 'history | upload', 'widget hidden by overflow');

    toolbar.removeById(wizard.id);
    await flush();
    assert.strictEqual(layout(toolbar), 'history | upload', 'removed widget');
  });

  it('rejects unknown and duplicate sections', () => {
    const toolbar = createToolbar();
    toolbar.defineSections(['a']);
    assert.throws(() => toolbar.addToSection('b', widget('x')), /Unknown toolbar section "b"/);
    assert.throws(() => toolbar.defineSections(['a']), /already defined/);
  });
});

describe('resolveContributions', () => {
  /**
   * @param {string} name
   * @param {object} options
   */
  const item = (name, options) => ({ element: widget(name), ...options });
  /** @param {ReturnType<typeof item>[]} items */
  const names = items => resolveContributions(items).map(c => c.element.getAttribute('name')).join(' ');

  it('orders by order and falls back to priority', () => {
    const items = [
      item('pdf', { order: 12, priority: 10 }),
      item('collection', { order: 14, priority: 5 }),
      item('actions', { priority: 8 }),
      item('variant', { order: 13, priority: 5 })
    ];
    assert.strictEqual(names(items), 'collection variant pdf actions');
  });

  it('leaves the priority of a contribution unchanged', () => {
    const [first] = resolveContributions([item('collection', { order: 14, priority: 5 })]);
    assert.strictEqual(first.priority, 5);
  });

  it('places the right zone by order, highest furthest right', () => {
    const items = [item('b', { position: 'right', order: 2, priority: 0 }), item('a', { position: 'right', order: 1, priority: 9 })];
    assert.strictEqual(names(items), 'a b');
  });
});

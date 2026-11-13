#!/usr/bin/env node

/**
 * Unit tests for the categories of the Tools menu.
 * @testCovers app/src/plugins/tools.js
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;

const templateHtml = readFileSync(new URL('../../../app/src/templates/tools-button.html', import.meta.url), 'utf-8');
const { createNavigableElement } = await import('../../../app/src/modules/navigable-element.js');

// The real ui-system loads templates over HTTP; build the button from the template file instead
mock.module('../../../app/src/modules/ui-system.js', {
  namedExports: {
    registerTemplate: async () => {},
    createSingleFromTemplate: () => {
      const container = document.createElement('div');
      container.innerHTML = templateHtml;
      return /** @type {HTMLElement} */ (container.querySelector('sl-button-group'));
    },
    createNavigableElement,
  },
});

const { default: ToolsPlugin } = await import('../../../app/src/plugins/tools.js');
const { default: ep } = await import('../../../app/src/extension-points.js');

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function item(text) {
  const el = document.createElement('sl-menu-item');
  el.textContent = text;
  return el;
}

describe('Tools menu categories', () => {
  it('adds items to an existing category after its last item, not at the end of the menu', () => {
    const tools = new ToolsPlugin(/** @type {any} */ ({}));
    tools[ep.toolbar.contentItems]();
    tools.addMenuItems([item('Model')], 'inference');
    tools.addMenuItems([item('Edit rules')], 'document-rules');
    tools.addMenuItems([item('Correct')], 'annotation');
    tools.addMenuItems([item('Test model'), item('Test results')], 'inference');
    tools.addMenuItems([item('Review')], 'annotation');
    const sequence = [...tools.menu.children].map(el => el.tagName === 'SL-DIVIDER' ? '---' : el.textContent);
    assert.deepStrictEqual(sequence, [
      'Inference', 'Model', 'Test model', 'Test results', '---',
      'Document Rules', 'Edit rules', '---',
      'Annotation', 'Correct', 'Review',
    ]);
  });
});

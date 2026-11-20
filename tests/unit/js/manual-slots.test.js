#!/usr/bin/env node

/**
 * Unit tests for the slots of the user manual that list the pages contributed by plugins.
 * @testCovers app/src/modules/manual-slots.js
 * @testCovers app/src/modules/markdown-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;
global.window = /** @type {any} */ (dom.window);
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;

const { contributionPagePath, fillManualSlots, parsePluginPagePath, pickManualFile, pluginPagePath, pluginPageUrl } =
  await import('../../../app/src/modules/manual-slots.js');
const { createMarkdownRenderer } = await import('../../../app/src/modules/markdown-utils.js');

/**
 * @param {Partial<import('../../../app/src/modules/api-client-v1.js').ManualContributionItem>} overrides
 */
function contribution(overrides = {}) {
  return {
    plugin_id: 'grobid', plugin_name: 'GROBID', plugin_version: '1.9.0', id: 'llm-review', slot: 'tutorials',
    title: 'LLM Reviewer with GROBID', description: 'Review by page.', files: { en: 'docs/llm-review.md' },
    order: 500, active: true, ...overrides
  };
}

/** @param {string} markdown */
function render(markdown) {
  const container = document.createElement('div');
  container.innerHTML = createMarkdownRenderer().render(markdown);
  return container;
}

describe('fillManualSlots', () => {
  it('replaces a slot with links to the pages contributed to it', () => {
    const container = render('# Plugins\n\n## Tutorials\n\n<!-- plugin-docs: tutorials -->\n\n<!-- plugin-docs: review -->\n');
    /** @type {string[]} */
    const opened = [];
    const count = fillManualSlots(container, [contribution(), contribution({ id: 'x', slot: 'admin', title: 'Admin' })], c => opened.push(c.id));
    assert.strictEqual(count, 2);
    const lists = container.querySelectorAll('ul.plugin-docs');
    assert.strictEqual(lists.length, 1);
    assert.strictEqual(lists[0].textContent, 'LLM Reviewer with GROBID - Review by page.');
    /** @type {HTMLAnchorElement} */ (lists[0].querySelector('a')).click();
    assert.deepStrictEqual(opened, ['llm-review']);
    assert.ok(container.querySelector('h2'), 'heading kept without hide-heading');
  });

  it('removes the heading before an empty slot with hide-heading', () => {
    const container = render('## Tutorials\n\n<!-- plugin-docs: tutorials hide-heading -->\n');
    fillManualSlots(container, [], () => {});
    assert.strictEqual(container.querySelector('h2'), null);
    assert.strictEqual(container.innerHTML.includes('plugin-docs'), false);
  });

  it('inserts titles as text and marks pages of inactive plugins', () => {
    const container = render('<!-- plugin-docs: tutorials -->\n');
    fillManualSlots(container, [contribution({ title: '<img src=x onerror=alert(1)>', active: false })], () => {});
    assert.strictEqual(container.querySelector('img'), null);
    assert.match(container.textContent || '', /<img src=x onerror=alert\(1\)>/);
    assert.match(container.textContent || '', /not enabled/);
  });

  it('ignores other comments', () => {
    const container = render('<!-- a comment -->\n\ntext\n');
    assert.strictEqual(fillManualSlots(container, [contribution()], () => {}), 0);
  });
});

describe('plugin page paths', () => {
  it('round-trips the virtual path', () => {
    const path = pluginPagePath('grobid', 'docs/llm-review.md');
    assert.strictEqual(path, 'plugins/grobid/docs/llm-review.md');
    assert.deepStrictEqual(parsePluginPagePath(path), { pluginId: 'grobid', file: 'docs/llm-review.md' });
    assert.strictEqual(pluginPageUrl({ pluginId: 'grobid', file: 'docs/a b.md' }), '/api/v1/manual/plugins/grobid/docs/a%20b.md');
  });

  it('does not parse core pages', () => {
    for (const path of ['index.md', 'user-manual/plugins.md', 'plugins/', 'plugins/grobid', 'plugins/grobid/']) {
      assert.strictEqual(parsePluginPagePath(path), null, path);
    }
  });
});

describe('contributionPagePath', () => {
  /** @type {any} */
  const contribution = { plugin_id: 'auto-annotation', files: { en: 'docs/a.md', de: 'docs/de/a.md' }, anchors: { en: 'transfer' } };
  it('appends the anchor of the chosen language', () => {
    assert.strictEqual(contributionPagePath(contribution, ['en-GB']), 'plugins/auto-annotation/docs/a.md#transfer');
    assert.strictEqual(contributionPagePath(contribution, ['de']), 'plugins/auto-annotation/docs/de/a.md');
    assert.strictEqual(contributionPagePath({ ...contribution, anchors: undefined }, []), 'plugins/auto-annotation/docs/a.md');
  });
});

describe('pickManualFile', () => {
  const files = { en: 'docs/en.md', de: 'docs/de.md' };
  it('picks the preferred language, its base language, then English', () => {
    assert.strictEqual(pickManualFile(files, ['de-AT', 'en']), 'docs/de.md');
    assert.strictEqual(pickManualFile(files, ['fr']), 'docs/en.md');
    assert.strictEqual(pickManualFile({ fr: 'docs/fr.md' }, ['de']), 'docs/fr.md');
  });
});

describe('createMarkdownRenderer without raw HTML', () => {
  it('shows raw HTML as text', () => {
    const html = createMarkdownRenderer({ html: false }).render('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    assert.strictEqual(html.includes('<script>'), false);
    assert.strictEqual(html.includes('href="javascript:'), false);
  });
});

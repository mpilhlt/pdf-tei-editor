#!/usr/bin/env node

/**
 * Unit tests for the "Personal version" badge and override splicing in the Annotation Guide drawer.
 * @testCovers app/src/plugins/annotation-guide.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
dom.window.Element.prototype.scrollIntoView = () => {};
global.Node =dom.window.Node;
global.CSS ={ escape: s => s };

const template = fs.readFileSync(new URL('../../../app/src/templates/annotation-guide-drawer.html', import.meta.url), 'utf8');
/** The drawer element built from the real template by the mocked createSingleFromTemplate */
let drawer = null;
mock.module('../../../app/src/modules/ui-system.js', {
  namedExports: {
    registerTemplate: async () => {},
    createSingleFromTemplate: () => {
      const holder = document.createElement('div');
      holder.innerHTML = template;
      drawer = holder.firstElementChild;
      return drawer;
    }
  }
});

const guide = { category: 'primary', refs: [] };
mock.module('../../../app/src/modules/tei-utils.js', {
  namedExports: { getEditorialDeclGuides: () => [guide] }
});

const ORIGINAL = '# Guide\n\n## Rules\n\noriginal rules\n\n## Other\n\nother text\n';
global.fetch = async () => ({ ok: true, text: async () => ORIGINAL });

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { default: AnnotationGuidePlugin } = await import('../../../app/src/plugins/annotation-guide.js');

/**
 * Installs the plugin with stubbed dependencies and loads the guide.
 * @param {{roles: string[]}} user
 * @param {{override?: object|null}|Error} response - What documentRulesSelectedOverride resolves to or throws
 * @returns {Promise<{calls: object[], warnings: string[]}>}
 */
async function loadGuide(user, response) {
  const app = new Application(new PluginManager(), new StateManager());
  const plugin = new AnnotationGuidePlugin(app.getPluginContext());
  const warnings = [];
  const calls = [];
  const deps = {
    logger: { debug: () => {}, warn: m => warnings.push(m), error: () => {} },
    help: { registerTopic: () => {} },
    dialog: { error: () => {} },
    xmleditor: { getXmlTree: () => ({}) },
    client: {
      documentRulesSelectedOverride: async req => {
        calls.push(req);
        if (response instanceof Error) throw response;
        return response;
      }
    }
  };
  plugin.getDependency = name => deps[name];
  Object.defineProperty(plugin, 'state', { get: () => ({ user, variant: 'v' }), configurable: true });
  await plugin.install({});
  await plugin.load('v');
  return { calls, warnings };
}

describe('AnnotationGuidePlugin personal version', () => {
  const override = { id: 'o1', note: 'my note', text: '## Rules\n\npersonal rules', format: 'markdown' };

  beforeEach(() => {
    guide.refs = [{ subtype: 'human', contentType: 'markdown', target: 'https://example.org/g.md#rules' }];
  });

  it('splices the selected override into the guide and shows the badge with the note as title', async () => {
    const { calls } = await loadGuide({ roles: ['reviewer'] }, { override });
    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', url: 'https://example.org/g.md#rules' }]);
    const html = drawer.content.innerHTML;
    assert.ok(html.includes('personal rules'));
    assert.ok(!html.includes('original rules'));
    assert.ok(html.includes('other text'));
    assert.strictEqual(drawer.personalBadge.hidden, false);
    assert.strictEqual(drawer.personalBadge.title, 'my note');
  });

  it('renders the original and hides the badge when no override is selected', async () => {
    await loadGuide({ roles: ['reviewer'] }, { override: null });
    assert.ok(drawer.content.innerHTML.includes('original rules'));
    assert.strictEqual(drawer.personalBadge.hidden, true);
  });

  it('does not query overrides for users without reviewer or admin role', async () => {
    const { calls } = await loadGuide({ roles: ['annotator'] }, { override });
    assert.deepStrictEqual(calls, []);
    assert.ok(drawer.content.innerHTML.includes('original rules'));
    assert.strictEqual(drawer.personalBadge.hidden, true);
  });

  it('does not query overrides when the URL has no heading anchor', async () => {
    guide.refs[0].target = 'https://example.org/g.md';
    const { calls } = await loadGuide({ roles: ['admin'] }, { override });
    assert.deepStrictEqual(calls, []);
  });

  it('renders the original and logs a warning when the lookup fails', async () => {
    const { warnings } = await loadGuide({ roles: ['reviewer'] }, new Error('boom'));
    assert.ok(drawer.content.innerHTML.includes('original rules'));
    assert.strictEqual(drawer.personalBadge.hidden, true);
    assert.ok(warnings.some(w => w.includes('boom')));
  });
});

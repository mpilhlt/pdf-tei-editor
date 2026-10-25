#!/usr/bin/env node

/**
 * Unit tests for opening a backend plugin endpoint from the URL hash (`#plugin=<id>/<endpoint>`).
 * @testCovers app/src/plugins/backend-plugins.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.history = dom.window.history;
global.HashChangeEvent = dom.window.HashChangeEvent;

const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: { notify: (...args) => { notifyCalls.push(args); } }
});
mock.module('../../../app/src/ui.js', {
  defaultExport: { spinner: { show: () => {}, hide: () => {} } }
});
mock.module('../../../app/src/modules/ui-system.js', {
  namedExports: { registerTemplate: async () => {}, createSingleFromTemplate: () => null }
});
mock.module('../../../app/src/modules/backend-plugin-sandbox.js', {
  namedExports: { PluginSandbox: class {} }
});

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { BackendPluginsPlugin } = await import('../../../app/src/plugins/backend-plugins.js');

/** @param {boolean} urlOpenable */
function makePlugin(urlOpenable) {
  const app = new Application(new PluginManager(), new StateManager());
  const plugin = new BackendPluginsPlugin(app.getPluginContext());
  Object.defineProperty(plugin, 'state', { get: () => ({ collection: 'state-collection', variant: 'state-variant' }), configurable: true });
  plugin.getDependency = (name) => {
    assert.strictEqual(name, 'logger');
    return { warn: () => {}, info: () => {} };
  };
  plugin.plugins = [{
    id: 'progress',
    name: 'Progress',
    endpoints: [{ name: 'show', label: 'Show', state_params: ['collection', 'variant'], url_openable: urlOpenable }]
  }];
  /** @type {Array<[string, string, Record<string, any>]>} */
  plugin.executed = [];
  plugin.executePlugin = async (p, endpointName, params) => { plugin.executed.push([p.id, endpointName, params]); };
  return plugin;
}

describe('BackendPluginsPlugin.openFromUrlHash', () => {
  beforeEach(() => {
    notifyCalls.length = 0;
  });

  it('opens an url_openable endpoint with state params from the hash and removes the plugin param', async () => {
    window.location.hash = '#plugin=progress/show&collection=c1';
    const plugin = makePlugin(true);
    await plugin.openFromUrlHash();
    assert.deepStrictEqual(plugin.executed, [['progress', 'show', { collection: 'c1', variant: 'state-variant' }]]);
    assert.strictEqual(new URLSearchParams(window.location.hash.slice(1)).has('plugin'), false);
    assert.strictEqual(new URLSearchParams(window.location.hash.slice(1)).get('collection'), 'c1');
  });

  it('refuses endpoints that are not url_openable', async () => {
    window.location.hash = '#plugin=progress/show';
    const plugin = makePlugin(false);
    await plugin.openFromUrlHash();
    assert.deepStrictEqual(plugin.executed, []);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(new URLSearchParams(window.location.hash.slice(1)).has('plugin'), false);
  });

  it('keeps the plugin param while the plugin is unknown (e.g. before login)', async () => {
    window.location.hash = '#plugin=other/show';
    const plugin = makePlugin(true);
    await plugin.openFromUrlHash();
    assert.deepStrictEqual(plugin.executed, []);
    assert.strictEqual(new URLSearchParams(window.location.hash.slice(1)).get('plugin'), 'other/show');
  });
});

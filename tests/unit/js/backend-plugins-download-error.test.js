#!/usr/bin/env node

/**
 * Unit tests for the error message shown when a backend plugin download fails.
 * @testCovers app/src/plugins/backend-plugins.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;

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

function makePlugin() {
  const app = new Application(new PluginManager(), new StateManager());
  const plugin = new BackendPluginsPlugin(app.getPluginContext());
  Object.defineProperty(plugin, 'state', { get: () => ({ sessionId: 's1' }), configurable: true });
  plugin.getDependency = () => ({ warn: () => {}, info: () => {} });
  return plugin;
}

/**
 * @param {number} status
 * @param {string} body
 * @param {string} [statusText]
 */
function stubFetch(status, body, statusText = '') {
  global.fetch = async () => new Response(body, { status, statusText });
}

describe('BackendPluginsPlugin.triggerDownload errors', () => {
  beforeEach(() => {
    notifyCalls.length = 0;
  });

  it('shows the detail message of a JSON error response', async () => {
    stubFetch(502, JSON.stringify({ detail: 'GROBID could not create training data for 1 document (d1).' }));
    const original = console.error;
    console.error = () => {};
    try {
      await makePlugin().triggerDownload({ id: 'grobid' }, '/api/plugins/grobid/download');
    } finally {
      console.error = original;
    }
    assert.deepStrictEqual(notifyCalls.map(c => c.slice(0, 2)), [
      ['Download failed: GROBID could not create training data for 1 document (d1).', 'danger']
    ]);
  });

  it('falls back to the status when the body has no detail', async () => {
    stubFetch(500, 'oops');
    const original = console.error;
    console.error = () => {};
    try {
      await makePlugin().triggerDownload({ id: 'grobid' }, '/x');
    } finally {
      console.error = original;
    }
    assert.strictEqual(notifyCalls[0][0], 'Download failed: HTTP 500');
  });

  it('stays silent on a cancelled download', async () => {
    stubFetch(499, JSON.stringify({ detail: 'Download cancelled by user' }));
    await makePlugin().triggerDownload({ id: 'grobid' }, '/x');
    assert.deepStrictEqual(notifyCalls, []);
  });
});

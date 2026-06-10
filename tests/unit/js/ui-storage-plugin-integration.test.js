/**
 * Integration tests: UIStorage access via PluginContext and Plugin base class.
 * @testCovers app/src/modules/plugin-context.js
 * @testCovers app/src/modules/plugin-base.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Suppress window.addEventListener call from Application constructor
// and provide a mock localStorage for UIStorage
// @ts-ignore
global.window = { addEventListener: () => {} };

// @ts-ignore
global.localStorage = (() => {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); }
  };
})();

import { UIStorage } from '../../../app/src/modules/ui-storage.js';
import PluginManager from '../../../app/src/modules/plugin-manager.js';
import StateManager from '../../../app/src/modules/state-manager.js';
import { Application } from '../../../app/src/modules/application.js';
import { Plugin } from '../../../app/src/modules/plugin-base.js';

function makeApp() {
  const pm = new PluginManager();
  const sm = new StateManager();
  return new Application(pm, sm);
}

describe('PluginContext.getUIStorage()', () => {
  it('returns a UIStorage instance with the given namespace', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();
    const store = ctx.getUIStorage('myplugin');
    assert.ok(store instanceof UIStorage);
  });

  it('namespaces keys correctly', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();
    const store = ctx.getUIStorage('myplugin');
    assert.strictEqual(store._namespace, 'myplugin');
  });
});

describe('Plugin.uiStorage getter', () => {
  it('returns UIStorage namespaced to plugin name', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();

    class TestPlugin extends Plugin {
      constructor(c) { super(c, { name: 'testplugin' }); }
    }
    const plugin = new TestPlugin(ctx);

    assert.ok(plugin.uiStorage instanceof UIStorage);
    assert.strictEqual(plugin.uiStorage._namespace, 'testplugin');
  });

  it('returns the same instance on repeated access (lazy singleton)', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();

    class TestPlugin extends Plugin {
      constructor(c) { super(c, { name: 'testplugin' }); }
    }
    const plugin = new TestPlugin(ctx);
    assert.strictEqual(plugin.uiStorage, plugin.uiStorage);
  });
});

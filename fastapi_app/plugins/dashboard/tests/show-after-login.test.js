/**
 * Unit tests for when the dashboard opens automatically.
 *
 * @testCovers fastapi_app/plugins/dashboard/extensions/dashboard.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

class FakeFrontendExtensionPlugin {
  constructor() {
    this.state = { sessionId: null };
    const values = new Map();
    this.uiStorage = {
      get: (key, defaultValue) => (values.has(key) ? values.get(key) : defaultValue),
      set: (key, value) => values.set(key, value)
    };
    this.configValue = true;
  }
  getDependency(name) {
    assert.strictEqual(name, 'config');
    return { get: async () => this.configValue };
  }
}
global.FrontendExtensionPlugin = FakeFrontendExtensionPlugin;
global.window = { location: { hash: '' } };

const { default: DashboardExtension } = await import('../extensions/dashboard.js');

/**
 * @param {string|null} sessionId
 * @param {boolean} [hasContributions=true]
 */
function buildExtension(sessionId, hasContributions = true) {
  const ext = new DashboardExtension({});
  ext.state.sessionId = sessionId;
  ext.opened = 0;
  ext.open = async () => {
    if (!hasContributions) return false;
    ext.opened += 1;
    return true;
  };
  return ext;
}

describe('DashboardExtension automatic opening', () => {
  it('opens once per login session, not again on reload', async () => {
    const ext = buildExtension('session-1');
    await ext.ready();
    await ext.ready();
    assert.strictEqual(ext.opened, 1);
  });

  it('opens again after a new login while the app runs', async () => {
    const ext = buildExtension('session-1');
    await ext.ready();
    await ext.onSessionIdChange(null);
    ext.state.sessionId = 'session-2';
    await ext.onSessionIdChange('session-2');
    assert.strictEqual(ext.opened, 2);
  });

  it('does not react to session changes before startup is complete', async () => {
    const ext = buildExtension('session-1');
    await ext.onSessionIdChange('session-1');
    assert.strictEqual(ext.opened, 0);
  });

  it('respects the configuration and does not remember sessions without contributions', async () => {
    const disabled = buildExtension('session-1');
    disabled.configValue = false;
    await disabled.ready();
    assert.strictEqual(disabled.opened, 0);

    const empty = buildExtension('session-1', false);
    await empty.ready();
    assert.strictEqual(empty.uiStorage.get('shownForSession'), undefined);
  });

  it('does not open when the page was opened with a link to a plugin view', async () => {
    global.window.location.hash = '#plugin=annotation-progress/show_progress&collection=c1';
    try {
      const ext = buildExtension('session-1');
      await ext.ready();
      assert.strictEqual(ext.opened, 0);
      // nor on a reload within the same login session
      global.window.location.hash = '';
      const reloaded = buildExtension('session-1');
      reloaded.uiStorage = ext.uiStorage;
      await reloaded.ready();
      assert.strictEqual(reloaded.opened, 0);
    } finally {
      global.window.location.hash = '';
    }
  });
});

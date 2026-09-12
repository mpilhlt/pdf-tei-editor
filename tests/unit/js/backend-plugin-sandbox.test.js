/**
 * Unit tests for PluginSandbox's document-reload and toast-notification methods.
 *
 * PluginSandbox transitively imports the XML editor plugin, which expects a
 * fully booted app DOM (custom elements, CodeMirror, etc.) and cannot be
 * imported as-is under a plain Node test. Since neither import is exercised
 * by the methods under test here, both are stubbed via node:test's
 * mock.module() so only a minimal `window.addEventListener` stub is needed.
 *
 * @testCovers app/src/modules/backend-plugin-sandbox.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

global.window = { addEventListener: () => {}, location: { origin: 'http://localhost' } };

mock.module('../../../app/src/plugins/xmleditor.js', {
  namedExports: { openDocumentAtLine: () => {} }
});

const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: {
    notify: (...args) => { notifyCalls.push(args); }
  }
});

const { PluginSandbox } = await import('../../../app/src/modules/backend-plugin-sandbox.js');

function makeSandbox({ xml = null, pdf = null, servicesLoad = async () => {} } = {}) {
  const services = { load: mock.fn(servicesLoad) };
  const context = {
    getCurrentState: () => ({ xml, pdf }),
    getDependency: (name) => (name === 'services' ? services : undefined)
  };
  const sandbox = new PluginSandbox(context, /** @type {any} */ ({}));
  return { sandbox, services };
}

describe('PluginSandbox.openControlledWindow()', () => {
  let originalOpen;
  let originalSetInterval;
  let originalClearInterval;

  beforeEach(() => {
    originalOpen = window.open;
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
    // Real timers would delay/hang the test runner for no benefit here -
    // openControlledWindow's own behavior under test finishes synchronously.
    global.setInterval = () => 0;
    global.clearInterval = () => {};
  });

  function restoreGlobals() {
    window.open = originalOpen;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  function makeWindowSandbox({ configValue = 'tab', windowOpenReturns = { closed: false } } = {}) {
    const configGet = mock.fn(async (_key, defaultValue) => configValue ?? defaultValue);
    const context = {
      getCurrentState: () => ({ sessionId: null }),
      getDependency: (name) => (name === 'config' ? { get: configGet } : undefined)
    };
    const sandbox = new PluginSandbox(context, /** @type {any} */ ({}));
    const windowOpen = mock.fn(() => windowOpenReturns);
    window.open = windowOpen;
    return { sandbox, windowOpen, configGet };
  }

  it("opens with no features (a plain tab) when config says 'tab' and none were given", async () => {
    const { sandbox, windowOpen, configGet } = makeWindowSandbox({ configValue: 'tab' });

    await sandbox.openControlledWindow('/some/url');

    assert.strictEqual(configGet.mock.callCount(), 1);
    assert.strictEqual(configGet.mock.calls[0].arguments[0], 'backend-plugins.open-target');
    assert.strictEqual(windowOpen.mock.calls[0].arguments[2], '');
    restoreGlobals();
  });

  it("opens a sized popup when config says 'window' and none were given", async () => {
    const { sandbox, windowOpen } = makeWindowSandbox({ configValue: 'window' });

    await sandbox.openControlledWindow('/some/url');

    assert.strictEqual(windowOpen.mock.calls[0].arguments[2], 'width=1200,height=800');
    restoreGlobals();
  });

  it('lets an explicit features argument override the config default', async () => {
    const { sandbox, windowOpen, configGet } = makeWindowSandbox({ configValue: 'window' });

    await sandbox.openControlledWindow('/some/url', '_blank', 'width=400,height=300');

    assert.strictEqual(configGet.mock.callCount(), 0);
    assert.strictEqual(windowOpen.mock.calls[0].arguments[2], 'width=400,height=300');
    restoreGlobals();
  });

  it('throws when window.open() returns null (popup blocked)', async () => {
    const { sandbox } = makeWindowSandbox({ windowOpenReturns: null });

    await assert.rejects(() => sandbox.openControlledWindow('/some/url'), /popup blocked/);
    restoreGlobals();
  });
});

describe('PluginSandbox.reloadCurrentDocument()', () => {
  it('reloads both xml and pdf from current state when both are open', async () => {
    const { sandbox, services } = makeSandbox({ xml: 'tei-1', pdf: 'pdf-1' });

    await sandbox.reloadCurrentDocument();

    assert.strictEqual(services.load.mock.callCount(), 1);
    assert.deepStrictEqual(services.load.mock.calls[0].arguments[0], {
      xml: 'tei-1',
      pdf: 'pdf-1'
    });
  });

  it('omits xml/pdf from the reload call when not currently open', async () => {
    const { sandbox, services } = makeSandbox({ xml: null, pdf: null });

    await sandbox.reloadCurrentDocument();

    assert.deepStrictEqual(services.load.mock.calls[0].arguments[0], {
      xml: undefined,
      pdf: undefined
    });
  });

  it('propagates errors from the underlying services.load() call', async () => {
    const { sandbox } = makeSandbox({
      xml: 'tei-1',
      servicesLoad: async () => { throw new Error('boom'); }
    });

    await assert.rejects(() => sandbox.reloadCurrentDocument(), /boom/);
  });
});

describe('PluginSandbox.notify()', () => {
  beforeEach(() => { notifyCalls.length = 0; });

  it('delegates to the shared notify() utility with given arguments', () => {
    const { sandbox } = makeSandbox();

    sandbox.notify('Feature file refreshed', 'success', 'check-circle');

    assert.strictEqual(notifyCalls.length, 1);
    assert.deepStrictEqual(notifyCalls[0], ['Feature file refreshed', 'success', 'check-circle']);
  });

  it('defaults to primary variant and info-circle icon', () => {
    const { sandbox } = makeSandbox();

    sandbox.notify('Hello');

    assert.deepStrictEqual(notifyCalls[0], ['Hello', 'primary', 'info-circle']);
  });
});

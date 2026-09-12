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

global.window = { addEventListener: () => {} };

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

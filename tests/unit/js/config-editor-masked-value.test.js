#!/usr/bin/env node

/**
 * Regression test for a config-editor bug: after saving a masked (password-style)
 * config value, the editor showed the input's placeholder as "(not set)" instead
 * of "(set but hidden)", even though the save succeeded and the value IS set.
 *
 * Root cause: ConfigEditorPlugin#saveValue() wrote the just-typed plaintext value
 * back into its local #originalConfig/#modifiedConfig cache for ALL keys, including
 * masked ones. On re-render, the masked editor (config-value-editor.js's
 * createMaskedValueEditor) decides the placeholder by checking
 * `currentValue === '****'` - but after a masked save, currentValue was the raw
 * secret, not the literal sentinel string, so it fell through to "(not set)".
 *
 * @testCovers app/src/plugins/config-editor.js
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const TEMPLATES_DIR = path.join(PROJECT_ROOT, 'app/src/templates');

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
}

// Set up jsdom globals before importing anything that touches the DOM.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.customElements = dom.window.customElements;
global.CustomEvent = dom.window.CustomEvent;
global.Event = dom.window.Event;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.Document = dom.window.Document;
global.DocumentFragment = dom.window.DocumentFragment;
global.NodeList = dom.window.NodeList;
global.HTMLTableElement = dom.window.HTMLTableElement;
global.HTMLTableSectionElement = dom.window.HTMLTableSectionElement;
global.HTMLInputElement = dom.window.HTMLInputElement;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.CSS = dom.window.CSS;
// config-editor.js's #createConfigRow() defers setReadOnly() via requestAnimationFrame.
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// ui-system.js's registerTemplate() fetches 'templates.json' in non-dev mode
// (jsdom's default location has no ?dev query param). Serve the real template
// files from disk instead of a real HTTP server.
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('templates.json')) {
    return {
      ok: true,
      json: async () => ({
        'config-editor-dialog': readTemplate('config-editor-dialog.html'),
        'config-editor-menu-item': readTemplate('config-editor-menu-item.html'),
      })
    };
  }
  throw new Error(`Unexpected fetch() call in test: ${u}`);
};

// notify()'s real implementation instantiates Shoelace's SlAlert and calls
// .toast(), which under jsdom leaves a dangling promise (waiting on a CSS
// transitionend event that jsdom never fires) - stub it, following the
// precedent in backend-plugin-sandbox.test.js.
const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: {
    notify: (...args) => { notifyCalls.push(args); }
  }
});

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { default: ConfigEditorPlugin } = await import('../../../app/src/plugins/config-editor.js');

/** setImmediate is a macrotask, so it runs after all pending microtasks (promise
 * chains from click handlers that aren't awaited by dispatchEvent) have drained.
 * @returns {Promise<void>}
 */
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build a real ConfigEditorPlugin wired to a real PluginContext, with mocked
 * 'client'/'tools'/'logger' dependencies.
 * @param {Record<string, any>} configListResponse - what apiClient.configList() resolves to
 * @returns {Promise<{plugin: InstanceType<typeof ConfigEditorPlugin>, configSetCalls: Array<{key: string, value: any}>}>}
 */
async function setupPlugin(configListResponse) {
  const app = new Application(new PluginManager(), new StateManager());
  const ctx = app.getPluginContext();

  const configSetCalls = [];
  const mockClient = {
    apiClient: {
      configList: async () => configListResponse,
      configSet: async ({ key, value }) => { configSetCalls.push({ key, value }); }
    }
  };
  const mockTools = {
    addMenuItems: (items) => { items.forEach(item => document.body.appendChild(item)); }
  };
  const mockLogger = { debug() {}, error() {}, warn() {}, info() {} };

  const plugin = new ConfigEditorPlugin(ctx);
  plugin.getDependency = (name) => {
    if (name === 'client') return mockClient;
    if (name === 'tools') return mockTools;
    if (name === 'logger') return mockLogger;
    throw new Error(`unexpected dependency: ${name}`);
  };

  await plugin.install({ user: null });
  await plugin.start();

  // Real sl-dialog custom element isn't registered under jsdom, so .show()/.hide()
  // don't exist - stub them, same as other tests treat unregistered Shoelace
  // elements as plain HTMLElements.
  const dialogEl = document.querySelector('sl-dialog[name="configEditorDialog"]');
  dialogEl.show = () => {};
  dialogEl.hide = () => {};

  return { plugin, configSetCalls };
}

/**
 * Open the config editor dialog by clicking its Tools-menu entry, and wait
 * for the async #openDialog()/#loadConfig() chain to settle.
 * @returns {Promise<void>}
 */
async function openDialog() {
  const menuItem = document.querySelector('sl-menu-item[name="configEditorMenuItem"]');
  menuItem.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushAsync();
}

/**
 * Double-click a row's value cell to enable editing, type a new value into
 * its input, and return the (freshly re-rendered) row + input.
 * @param {string} key
 * @param {string} newValue
 * @returns {{row: HTMLTableRowElement, input: HTMLElement}}
 */
function editMaskedValue(key, newValue) {
  let row = document.querySelector(`tr[data-key="${key}"]`);
  const valueCell = row.children[2];
  valueCell.dispatchEvent(new dom.window.Event('dblclick', { bubbles: true }));

  // #enableEditing() re-renders the whole tbody, so re-query.
  row = document.querySelector(`tr[data-key="${key}"]`);
  const input = row.querySelector('sl-input');
  input.value = newValue;
  input.dispatchEvent(new dom.window.CustomEvent('sl-input'));

  return { row, input };
}

/**
 * Click the (now-visible) Save button for a row and wait for the async
 * #saveValue() chain to settle.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function clickSave(key) {
  const row = document.querySelector(`tr[data-key="${key}"]`);
  const saveBtn = row.querySelector('sl-icon-button[name="check-circle"]');
  saveBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flushAsync();
}

describe('ConfigEditorPlugin - masked value placeholder after save', () => {
  it('shows "(set but hidden)", not "(not set)", right after saving a new masked value', async () => {
    const KEY = 'plugin.kisski.api.key';
    const { plugin, configSetCalls } = await setupPlugin({
      [KEY]: '****',
      [`${KEY}.masked`]: true,
      [`${KEY}.description`]: 'API key for the KISSKI Academic Cloud service'
    });

    await openDialog();

    // Sanity check: before any edit, the sentinel is recognized correctly.
    let row = document.querySelector(`tr[data-key="${KEY}"]`);
    let input = row.querySelector('sl-input');
    assert.strictEqual(input.getAttribute('placeholder'), '(set but hidden)',
      'expected the initial sentinel value to render as "(set but hidden)"');

    editMaskedValue(KEY, 'brand-new-real-secret-value');
    await clickSave(KEY);

    // The real value must have reached the backend...
    assert.deepStrictEqual(configSetCalls, [{ key: KEY, value: 'brand-new-real-secret-value' }]);

    // ...but the re-rendered row must NOT reveal or imply the value is missing.
    row = document.querySelector(`tr[data-key="${KEY}"]`);
    input = row.querySelector('sl-input');
    assert.strictEqual(
      input.getAttribute('placeholder'),
      '(set but hidden)',
      'BUG: after saving a masked value, the editor incorrectly showed "(not set)" ' +
      'because it re-rendered using the raw just-saved secret instead of the "****" sentinel'
    );
  });
});

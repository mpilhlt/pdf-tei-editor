#!/usr/bin/env node

/**
 * Unit tests for the document-rules plugin (Edit prompts/schemas submenu,
 * resource editor dialog, Refresh document rules action).
 * @testCovers app/src/plugins/document-rules.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
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
// document-rules.js (unlike inference-settings.js) imports ui-system.js,
// which imports ui.js, which imports spinner.js ("class Spinner extends
// HTMLElement" - evaluated at module-load time), so plain window/document
// globals are not enough here - see config-editor-masked-value.test.js for
// the same requirement/pattern.
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
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.CSS = dom.window.CSS;

global.localStorage = (() => {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); }
  };
})();

// ui-system.js's registerTemplate() fetches 'templates.json' in non-dev mode
// (jsdom's default location has no ?dev query param). Serve the real template
// files from disk instead of a real HTTP server - document-rules.js registers
// all three of its templates at module load time.
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('templates.json')) {
    return {
      ok: true,
      json: async () => ({
        'document-rules-menu-item': readTemplate('document-rules-menu-item.html'),
        'document-rules-refresh-menu-item': readTemplate('document-rules-refresh-menu-item.html'),
        'document-rules-editor-dialog': readTemplate('document-rules-editor-dialog.html'),
      })
    };
  }
  throw new Error(`Unexpected fetch() call in test: ${u}`);
};

const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: {
    notify: (...args) => { notifyCalls.push(args); }
  }
});

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { default: DocumentRulesPlugin } = await import('../../../app/src/plugins/document-rules.js');

/** @returns {InstanceType<typeof DocumentRulesPlugin>} */
function makePlugin() {
  const app = new Application(new PluginManager(), new StateManager());
  const ctx = app.getPluginContext();
  const plugin = new DocumentRulesPlugin(ctx);
  Object.defineProperty(plugin, 'state', { get: () => ({ xml: 'stable123', user: { username: 'u', roles: ['user'] } }), configurable: true });
  return plugin;
}

/**
 * A minimal stand-in for `_editorDialogUi` mirroring the exact nested shape
 * document-rules-editor-dialog.html's typedef produces (see Task 2 of
 * docs/superpowers/plans/2026-09-28-document-rules-frontend.md), so dialog
 * logic can be tested without going through install()'s real template/DOM
 * pipeline.
 * @returns {any}
 */
function makeDialogUi() {
  const el = document.createElement('div');
  el.overrideRow = document.createElement('div');
  el.noteInput = Object.assign(document.createElement('sl-input'), { value: '' });
  const editPanel = { textArea: Object.assign(document.createElement('sl-textarea'), { value: '', readonly: false }) };
  const previewPanel = { previewContent: document.createElement('div') };
  const textTabs = Object.assign(document.createElement('sl-tab-group'), { editPanel, previewPanel });
  el.textBody = Object.assign(document.createElement('div'), { textTabs });
  el.xmlBody = Object.assign(document.createElement('div'), { xmlContainer: document.createElement('div') });
  el.newOverrideBtn = document.createElement('sl-button');
  el.saveBtn = document.createElement('sl-button');
  el.deleteBtn = document.createElement('sl-button');
  el.resetBtn = document.createElement('sl-button');
  el.closeBtn = document.createElement('sl-button');
  el.open = false;
  return el;
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => { global.localStorage.clear(); notifyCalls.length = 0; });

describe('DocumentRulesPlugin construction', () => {
  it('has the expected name and dependencies', () => {
    const plugin = makePlugin();
    assert.strictEqual(plugin.name, 'document-rules');
    assert.deepStrictEqual(plugin.deps, ['client', 'tools', 'xmleditor', 'dialog', 'services', 'logger']);
  });
});

describe('DocumentRulesPlugin._populateSubmenu', () => {
  it('renders one sl-menu-item per resource, with kind/url dataset attributes', () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin._resources = [
      { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'Data correction', format: 'markdown' },
      { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml' },
    ];
    plugin._populateSubmenu();
    const items = [...plugin._editMenuItem.documentRulesEditSubmenu.children];
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].textContent, 'Data correction');
    assert.strictEqual(items[0].dataset.kind, 'interpretation-ref');
    assert.strictEqual(items[1].textContent, 'Schema (RelaxNG)');
  });

  it('clears previous contents on repeated calls', () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin._resources = [{ kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }];
    plugin._populateSubmenu();
    plugin._populateSubmenu();
    assert.strictEqual(plugin._editMenuItem.documentRulesEditSubmenu.children.length, 1);
  });

  it('clicking an item opens the resource editor for it', () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    const resource = { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' };
    plugin._resources = [resource];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._populateSubmenu();
    plugin._editMenuItem.documentRulesEditSubmenu.querySelector('sl-menu-item').dispatchEvent(new dom.window.Event('click'));
    assert.deepStrictEqual(opened, resource);
  });
});

describe('DocumentRulesPlugin._selectOverride', () => {
  it('persists the selection and re-renders showing the override text', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [{ id: 'ov1', note: 'my note', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = null;
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesSelection: async (body) => { calls.push(body); } } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin._selectOverride('ov1');

    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', fragment_url: 'https://example.com/a.md', override_id: 'ov1' }]);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value, 'override text');
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, false);
  });

  it('is a no-op when the target is already selected', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'schema', url: 'u', key: 'u', label: 'S', format: 'xml' };
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    let called = false;
    plugin.getDependency = () => { called = true; return { apiClient: {} }; };
    await plugin._selectOverride(null);
    assert.strictEqual(called, false);
  });

  it('selecting the original makes the text read-only', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin.getDependency = () => ({ apiClient: { documentRulesSelection: async () => {} } });

    await plugin._selectOverride(null);

    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value, 'original text');
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, true);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, 'none');
    assert.strictEqual(plugin._editorDialogUi.noteInput.style.display, 'none');
  });
});

describe('DocumentRulesPlugin format-based body swap', () => {
  it('shows the text body and hides the xml body for a markdown resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.textBody.style.display, '');
    assert.strictEqual(plugin._editorDialogUi.xmlBody.style.display, 'none');
  });

  it('shows the xml body and hides the text body for a schema resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    let setContentArgs;
    plugin._setXmlContent = (...args) => { setContentArgs = args; };
    plugin._currentResource = { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' };
    plugin._currentOriginalText = '<grammar/>';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.textBody.style.display, 'none');
    assert.strictEqual(plugin._editorDialogUi.xmlBody.style.display, '');
    assert.deepStrictEqual(setContentArgs, ['<grammar/>', true]);
  });

  it('renders a markdown preview of the current text on the preview tab', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = '# Heading';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._md = { render: (text) => `<h1>${text.replace('# ', '')}</h1>` };
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML, '<h1>Heading</h1>');
  });
});

describe('DocumentRulesPlugin._onNewOverride/_onSave/_onDelete/_onReset', () => {
  function setup() {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value = 'original text';
    return plugin;
  }

  it('_onNewOverride creates an override from the shown text and selects it', async () => {
    const plugin = setup();
    const created = { id: 'ov1', note: '', text: 'original text', format: 'markdown', created_at: '', updated_at: '' };
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesOverrides: async (body) => { calls.push(body); return created; },
        documentRulesSelection: async () => {},
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onNewOverride();
    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', fragment_url: 'https://example.com/a.md', note: '', text: 'original text' }]);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
    assert.deepStrictEqual(plugin._currentOverrides, [created]);
  });

  it('_onSave persists the note and shown text for the selected override', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: 'old note', text: 'old text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin._editorDialogUi.noteInput.value = 'new note';
    plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value = 'new text';
    const updated = { id: 'ov1', note: 'new note', text: 'new text', format: 'markdown', created_at: '', updated_at: '' };
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesUpdateOverrides: async (id, body) => { calls.push([id, body]); return updated; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onSave();
    assert.deepStrictEqual(calls, [['ov1', { note: 'new note', text: 'new text' }]]);
    assert.deepStrictEqual(plugin._currentOverrides[0], updated);
  });

  it('_onSave is a no-op when Original is selected', async () => {
    const plugin = setup();
    let called = false;
    plugin.getDependency = () => { called = true; return { apiClient: {} }; };
    await plugin._onSave();
    assert.strictEqual(called, false);
  });

  it('_onDelete removes the override and reverts to Original after confirmation', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deletedId;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'client') return { apiClient: { documentRulesDeleteOverrides: async (id) => { deletedId = id; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onDelete();
    assert.strictEqual(deletedId, 'ov1');
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.deepStrictEqual(plugin._currentOverrides, []);
  });

  it('_onDelete does nothing when the confirmation is declined', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deleteCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => false };
      if (name === 'client') return { apiClient: { documentRulesDeleteOverrides: async () => { deleteCalled = true; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onDelete();
    assert.strictEqual(deleteCalled, false);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
  });

  it('_onReset clears the selection but keeps the overrides', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesSelection: async (body) => { calls.push(body); } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', fragment_url: 'https://example.com/a.md', override_id: null }]);
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.deepStrictEqual(plugin._currentOverrides.length, 1, 'override itself must not be deleted');
  });
});

describe('DocumentRulesPlugin.onUserChange / role gating', () => {
  it('hides the refresh menu item for a user without reviewer/admin role', () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin.onUserChange({ roles: ['user'] });
    assert.strictEqual(plugin._refreshMenuItem.style.display, 'none');
  });

  it('shows the refresh menu item for a reviewer', () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin.onUserChange({ roles: ['reviewer'] });
    assert.strictEqual(plugin._refreshMenuItem.style.display, '');
  });

  it('shows the refresh menu item for an admin', () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin.onUserChange({ roles: ['admin'] });
    assert.strictEqual(plugin._refreshMenuItem.style.display, '');
  });
});

describe('DocumentRulesPlugin._onRefreshDocumentRules', () => {
  it('does nothing (with a warning toast) when no document is open', async () => {
    const plugin = makePlugin();
    Object.defineProperty(plugin, 'state', { get: () => ({ xml: null }), configurable: true });
    let previewCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesRefreshPreview: async () => { previewCalled = true; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(previewCalled, false);
    assert.match(notifyCalls[0][0], /No document is open/);
  });

  it('shows the preview message and does not execute when nothing is available to refresh', async () => {
    const plugin = makePlugin();
    let executeCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => { throw new Error('confirm should not be called'); } };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: false, changed: false, entry_count: 0, variant_id: null, message: 'No rule-refresh provider for this document.' }),
        documentRulesRefreshExecute: async () => { executeCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(executeCalled, false);
    assert.match(notifyCalls[0][0], /No rule-refresh provider/);
  });

  it('does not execute when the user declines the confirmation', async () => {
    const plugin = makePlugin();
    let executeCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => false };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Would regenerate 2 entries.' }),
        documentRulesRefreshExecute: async () => { executeCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(executeCalled, false);
  });

  it('executes and reloads the editor when confirmed and something changed', async () => {
    const plugin = makePlugin();
    let reloadedWith;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'services') return { load: async (opts) => { reloadedWith = opts; } };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Would regenerate 2 entries.' }),
        documentRulesRefreshExecute: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Regenerated 2 entries.' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.deepStrictEqual(reloadedWith, { xml: 'stable123' });
    assert.strictEqual(notifyCalls[0][0], 'Regenerated 2 entries.');
  });

  it('reports both a success and a danger toast when the post-refresh editor reload fails', async () => {
    const plugin = makePlugin();
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'services') return { load: async () => { throw new Error('locked'); } };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Would regenerate 2 entries.' }),
        documentRulesRefreshExecute: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Regenerated 2 entries.' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(notifyCalls.length, 2);
    assert.strictEqual(notifyCalls[0][0], 'Regenerated 2 entries.');
    assert.strictEqual(notifyCalls[0][1], 'success');
    assert.match(notifyCalls[1][0], /reloading the editor failed: locked/);
    assert.strictEqual(notifyCalls[1][1], 'danger');
  });

  it('does not reload the editor when execute reports nothing changed', async () => {
    const plugin = makePlugin();
    let reloadCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'services') return { load: async () => { reloadCalled = true; } };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: false, entry_count: 0, variant_id: 'v', message: 'Already up to date.' }),
        documentRulesRefreshExecute: async () => ({ available: true, changed: false, entry_count: 0, variant_id: 'v', message: 'Already up to date.' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(reloadCalled, false);
  });
});

describe('DocumentRulesPlugin._refreshResources', () => {
  it('hides the menu item when no document is open', async () => {
    const plugin = makePlugin();
    Object.defineProperty(plugin, 'state', { get: () => ({ xml: null }), configurable: true });
    plugin._editMenuItem = { style: {}, documentRulesEditSubmenu: document.createElement('sl-menu') };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, 'none');
  });

  it('shows the menu item disabled when the document has no resources', async () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, '');
    assert.strictEqual(plugin._editMenuItem.disabled, true);
  });

  it('shows the menu item enabled with a populated submenu when resources exist', async () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { style: {}, disabled: true, documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [
        { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }
      ] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, '');
    assert.strictEqual(plugin._editMenuItem.disabled, false);
    assert.strictEqual(plugin._editMenuItem.documentRulesEditSubmenu.children.length, 1);
  });

  it('keeps stale resources and does not clear the submenu when a later fetch fails', async () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { style: {}, disabled: true, documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [
        { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }
      ] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._resources.length, 1);

    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => { throw new Error('network error'); } } };
      if (name === 'logger') return { warn: () => {}, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await assert.doesNotReject(() => plugin._refreshResources());
    assert.strictEqual(plugin._resources.length, 1, 'stale _resources must be preserved on a failed fetch');
  });
});

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

if (typeof global.navigator === 'undefined') {
  global.navigator = {};
}

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
const { createMarkdownRenderer } = await import('../../../app/src/modules/markdown-utils.js');

/**
 * @param {string[]} [roles] - defaults to a plain, non-privileged user;
 *   pass e.g. ['reviewer'] for tests that exercise #doRefreshResources()'s
 *   resource-listing plumbing, which now requires the reviewer/admin role
 *   this whole "Document rules" category is gated behind.
 * @returns {InstanceType<typeof DocumentRulesPlugin>}
 */
function makePlugin(roles = ['user']) {
  const app = new Application(new PluginManager(), new StateManager());
  const ctx = app.getPluginContext();
  const plugin = new DocumentRulesPlugin(ctx);
  Object.defineProperty(plugin, 'state', { get: () => ({ xml: 'stable123', user: { username: 'u', roles } }), configurable: true });
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
  el.proposeUpstreamBtn = document.createElement('sl-button');
  el.closeBtn = document.createElement('sl-button');
  el.open = false;
  return el;
}

/**
 * SlTextarea's `input` (its internal `<textarea>`, see scrollPosition() in
 * @shoelace-style/shoelace's textarea chunk) is a `@query`-backed
 * getter-only accessor - `Object.assign`/plain assignment throws ("has only
 * a getter"), so give it a real, writable `<textarea>` stand-in the same
 * way makeOverridesWidgetStub() shadows `isConnected`. Needed by any test
 * that exercises _scrollMarkdownBodyToAnchor()'s line-height calculation.
 * @param {any} textArea
 * @returns {HTMLTextAreaElement}
 */
function stubTextAreaInput(textArea) {
  const input = document.createElement('textarea');
  Object.defineProperty(textArea, 'input', { value: input, configurable: true });
  return input;
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Creates a detached element with a writable `isConnected` for use as a
 * `_overridesWidget` stand-in. jsdom defines `Node.prototype.isConnected` as
 * a getter-only accessor, so `Object.assign(el, { isConnected })` throws
 * ("has only a getter") - `Object.defineProperty` shadows it with an
 * own, writable property instead.
 * @param {boolean} connected
 * @param {string} id
 * @returns {HTMLElement}
 */
function makeOverridesWidgetStub(connected, id) {
  const el = document.createElement('span');
  Object.defineProperty(el, 'isConnected', { value: connected, writable: true, configurable: true });
  el.id = id;
  return el;
}

/**
 * Minimal stand-ins for the headerbar widget and CodeMirror ref-decoration
 * slot fields that _refreshOverrideIndicators()/_refreshRefDecorations()
 * (added in Tasks 2 and 4 of the editor-integration plan) read/write on
 * every code path that mutates the override selection or resource list
 * (_selectOverride/_onDelete/_onReset/#doRefreshResources all call
 * _refreshOverrideIndicators() after their own work). Attached so existing
 * tests exercising those methods don't each need a full headerbar-widget
 * setup - the widget starts disconnected, so it never touches the
 * `xmleditor` dependency unless a test explicitly connects it.
 * @param {InstanceType<typeof DocumentRulesPlugin>} plugin
 */
function wireOverrideIndicatorStubs(plugin) {
  plugin._overridesWidget = makeOverridesWidgetStub(false, 'overrides-widget');
  plugin._refDecorationSlot = { reconfigure: () => {} };
}

beforeEach(() => { global.localStorage.clear(); notifyCalls.length = 0; });

describe('DocumentRulesPlugin.start', () => {
  it('registers both menu items in the document-rules category, wires mouseenter/click, and gates initial visibility by role', async () => {
    const plugin = makePlugin(); // makePlugin()'s default user has roles: ['user'] - refresh item stays hidden
    wireOverrideIndicatorStubs(plugin);
    let addedItems, addedCategory;
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items, category) => { addedItems = items; addedCategory = category; } };
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [] }) } };
      if (name === 'logger') return { debug: () => {}, warn: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    await flushMicrotasks(); // let the fire-and-forget _refreshResources() call settle

    assert.strictEqual(addedCategory, 'document-rules');
    assert.deepStrictEqual(addedItems, [plugin._editMenuItem, plugin._refreshMenuItem]);
    assert.strictEqual(plugin._refreshMenuItem.style.display, 'none');

    let refreshCalled = false;
    plugin._refreshResources = () => { refreshCalled = true; return Promise.resolve(); };
    plugin._editMenuItem.dispatchEvent(new dom.window.Event('mouseenter'));
    assert.strictEqual(refreshCalled, true, 'expected mouseenter on the parent item to trigger _refreshResources()');

    let onRefreshCalled = false;
    plugin._onRefreshDocumentRules = () => { onRefreshCalled = true; return Promise.resolve(); };
    plugin._refreshMenuItem.dispatchEvent(new dom.window.Event('click'));
    assert.strictEqual(onRefreshCalled, true, 'expected click on the refresh item to trigger _onRefreshDocumentRules()');
  });

  it('shows the refresh menu item immediately for a reviewer/admin user', async () => {
    const plugin = makePlugin();
    wireOverrideIndicatorStubs(plugin);
    Object.defineProperty(plugin, 'state', { get: () => ({ xml: 'stable123', user: { username: 'u', roles: ['admin'] } }), configurable: true });
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: () => {} };
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [] }) } };
      if (name === 'logger') return { debug: () => {}, warn: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    await flushMicrotasks(); // let the fire-and-forget _refreshResources() call settle

    assert.strictEqual(plugin._refreshMenuItem.style.display, '');
  });
});

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
    wireOverrideIndicatorStubs(plugin);
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
    wireOverrideIndicatorStubs(plugin);
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

describe('DocumentRulesPlugin scroll position on render', () => {
  it('resets the CodeMirror view to the top of the document for an xml resource', () => {
    const plugin = makePlugin();
    const dispatched = [];
    plugin._cmView = {
      state: { doc: { length: 5 } },
      dispatch: (spec) => { dispatched.push(spec); },
      scrollDOM: { scrollTop: 500 }
    };
    plugin._setXmlContent('<grammar/>', true);
    assert.strictEqual(plugin._cmView.scrollDOM.scrollTop, 0);
  });

  it('resets the markdown edit textarea and preview to the top when the resource has no heading-anchor fragment', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'some text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    const textArea = plugin._editorDialogUi.textBody.textTabs.editPanel.textArea;
    stubTextAreaInput(textArea);
    const scrollCalls = [];
    textArea.scrollPosition = (pos) => scrollCalls.push(pos);
    plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent.scrollTop = 500;

    plugin._renderEditorDialog();

    assert.deepStrictEqual(scrollCalls, [{ top: 0 }]);
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent.scrollTop, 0);
  });

  it('does not scroll past the top for a line-range fragment (already sliced server-side, nothing to locate)', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md#L5-L10', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'line1\nline2\nline3\n';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    const textArea = plugin._editorDialogUi.textBody.textTabs.editPanel.textArea;
    stubTextAreaInput(textArea);
    const scrollCalls = [];
    textArea.scrollPosition = (pos) => scrollCalls.push(pos);

    plugin._renderEditorDialog();

    assert.deepStrictEqual(scrollCalls, [{ top: 0 }]);
  });

  it('scrolls the edit textarea and preview to the heading matching a "human" ref\'s heading-anchor fragment (e.g. "#data-correction")', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = createMarkdownRenderer();
    plugin._currentResource = {
      kind: 'interpretation-ref',
      url: 'https://example.com/guidelines.md#data-correction',
      key: 'a', label: 'Data correction', format: 'markdown'
    };
    plugin._currentOriginalText = '# Guidelines\n\nIntro.\n\n## Data correction\n\nBody text.\n';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    const textArea = plugin._editorDialogUi.textBody.textTabs.editPanel.textArea;
    const input = stubTextAreaInput(textArea);
    input.style.lineHeight = '20px';
    const scrollCalls = [];
    textArea.scrollPosition = (pos) => scrollCalls.push(pos);

    plugin._renderEditorDialog();

    // "## Data correction" is on line 5 (1-based) -> (5 - 1) * 20px.
    assert.deepStrictEqual(scrollCalls, [{ top: 80 }]);

    const previewContent = plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent;
    assert.ok(previewContent.querySelector('#data-correction'), 'preview must render a heading with the matching id');
  });

  it('does not scroll to a fragment for a non-markdown resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.txt#data-correction', key: 'a', label: 'A', format: 'text' };
    plugin._currentOriginalText = 'plain text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    const textArea = plugin._editorDialogUi.textBody.textTabs.editPanel.textArea;
    stubTextAreaInput(textArea);
    const scrollCalls = [];
    textArea.scrollPosition = (pos) => scrollCalls.push(pos);

    plugin._renderEditorDialog();

    assert.deepStrictEqual(scrollCalls, [{ top: 0 }]);
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
    wireOverrideIndicatorStubs(plugin);
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

describe('DocumentRulesPlugin._onProposeUpstream', () => {
  function setup() {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'old text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value = 'shown text';
    return plugin;
  }

  let clipboardCalls;
  let openCalls;
  let confirmCalls;
  let confirmReturns;

  beforeEach(() => {
    clipboardCalls = [];
    openCalls = [];
    confirmCalls = [];
    confirmReturns = true;
    global.navigator.clipboard = { writeText: async (text) => { clipboardCalls.push(text); } };
    dom.window.open = (...args) => { openCalls.push(args); };
  });

  /** @param {(name: string) => object} clientDependency */
  function withDialog(plugin, clientDependency) {
    plugin.getDependency = (name) => {
      if (name === 'client') return clientDependency;
      if (name === 'dialog') return { confirm: async (message, title) => { confirmCalls.push([message, title]); return confirmReturns; } };
      throw new Error(`unexpected dependency: ${name}`);
    };
  }

  it('confirms, then copies the shown text to the clipboard and opens a prefilled tab', async () => {
    const plugin = setup();
    let calledWith;
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async (body) => { calledWith = body; return { url: 'https://github.com/mpilhlt/pdf-tei-editor/new/main?filename=rules.md&value=shown+text', content_prefilled: true }; },
    } });
    await plugin._onProposeUpstream();
    assert.deepStrictEqual(calledWith, { url: 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md', text: 'shown text' });
    assert.strictEqual(confirmCalls.length, 1);
    assert.match(confirmCalls[0][0], /prefilled/);
    assert.deepStrictEqual(clipboardCalls, ['shown text']);
    assert.deepStrictEqual(openCalls[0], ['https://github.com/mpilhlt/pdf-tei-editor/new/main?filename=rules.md&value=shown+text', '_blank', 'noopener']);
  });

  it('confirms with clipboard-fallback wording and opens an unprefilled tab when content_prefilled is false', async () => {
    const plugin = setup();
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => ({ url: 'https://gitlab.com/group/project/-/edit/main/rules.md', content_prefilled: false }),
    } });
    await plugin._onProposeUpstream();
    assert.match(confirmCalls[0][0], /clipboard/);
    assert.deepStrictEqual(clipboardCalls, ['shown text']);
    assert.strictEqual(openCalls[0][0], 'https://gitlab.com/group/project/-/edit/main/rules.md');
  });

  it('does not copy or open anything when the user cancels the confirmation', async () => {
    const plugin = setup();
    confirmReturns = false;
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => ({ url: 'https://gitlab.com/group/project/-/edit/main/rules.md', content_prefilled: false }),
    } });
    await plugin._onProposeUpstream();
    assert.strictEqual(confirmCalls.length, 1);
    assert.strictEqual(clipboardCalls.length, 0);
    assert.strictEqual(openCalls.length, 0);
  });

  it('shows a warning and opens nothing when the resource host is not a recognized forge', async () => {
    const plugin = setup();
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => ({ url: null, content_prefilled: false }),
    } });
    await plugin._onProposeUpstream();
    assert.strictEqual(confirmCalls.length, 0);
    assert.strictEqual(openCalls.length, 0);
    assert.strictEqual(clipboardCalls.length, 0);
    assert.match(notifyCalls[0][0], /not hosted on a recognized git forge/);
  });

  it('shows a danger toast and opens nothing when the backend call fails', async () => {
    const plugin = setup();
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => { throw new Error('network down'); },
    } });
    await plugin._onProposeUpstream();
    assert.strictEqual(confirmCalls.length, 0);
    assert.strictEqual(openCalls.length, 0);
    assert.match(notifyCalls[0][0], /Could not build the upstream link/);
  });

  it('still opens the tab when the clipboard write is denied', async () => {
    const plugin = setup();
    global.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => ({ url: 'https://github.com/mpilhlt/pdf-tei-editor/new/main?filename=rules.md&value=shown+text', content_prefilled: true }),
    } });
    await plugin._onProposeUpstream();
    assert.strictEqual(openCalls.length, 1);
  });
});

describe('DocumentRulesPlugin._renderEditorDialog proposeUpstreamBtn visibility', () => {
  it('is hidden when Original is selected and shown when an override is selected', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'text';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];

    plugin._currentSelectedId = null;
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.proposeUpstreamBtn.style.display, 'none');

    plugin._currentSelectedId = 'ov1';
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.proposeUpstreamBtn.style.display, '');
  });
});

describe('DocumentRulesPlugin.onUserChange / role gating', () => {
  it('hides the refresh menu item for a user without reviewer/admin role, and also hides "Edit prompts/schemas" via the re-triggered resource refresh', async () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin._editMenuItem = { style: {}, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
    plugin.onUserChange({ roles: ['user'] });
    await flushMicrotasks();
    assert.strictEqual(plugin._refreshMenuItem.style.display, 'none');
    assert.strictEqual(plugin._editMenuItem.style.display, 'none');
  });

  it('shows the refresh menu item for a reviewer', async () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    plugin.onUserChange({ roles: ['reviewer'] });
    await flushMicrotasks();
    assert.strictEqual(plugin._refreshMenuItem.style.display, '');
  });

  it('shows the refresh menu item for an admin', async () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    plugin.onUserChange({ roles: ['admin'] });
    await flushMicrotasks();
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

  it('hides the menu item entirely for a user without the reviewer/admin role, without even fetching the resource list', async () => {
    const plugin = makePlugin(['user']);
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    let fetched = false;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => { fetched = true; return { state: { doc: { toString: () => '<TEI/>' } } }; } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, 'none');
    assert.strictEqual(fetched, false, 'expected the role gate to short-circuit before reading the editor content');
  });

  it('shows the menu item disabled when the document has no resources', async () => {
    const plugin = makePlugin(['reviewer']);
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
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
    const plugin = makePlugin(['reviewer']);
    plugin._editMenuItem = { style: {}, disabled: true, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: {
        documentRulesList: async () => ({ resources: [
          { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }
        ] }),
        documentRulesSelections: async () => ({ selections: [{ kind: 'schema', url: 'u', selected: false }] }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, '');
    assert.strictEqual(plugin._editMenuItem.disabled, false);
    assert.strictEqual(plugin._editMenuItem.documentRulesEditSubmenu.children.length, 1);
  });

  it('keeps stale resources and does not clear the submenu when a later fetch fails', async () => {
    const plugin = makePlugin(['reviewer']);
    plugin._editMenuItem = { style: {}, disabled: true, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: {
        documentRulesList: async () => ({ resources: [
          { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }
        ] }),
        documentRulesSelections: async () => ({ selections: [{ kind: 'schema', url: 'u', selected: false }] }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._resources.length, 1);

    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: {
        documentRulesList: async () => { throw new Error('network error'); },
        documentRulesSelections: async () => ({ selections: [{ kind: 'schema', url: 'u', selected: false }] }),
      } };
      if (name === 'logger') return { warn: () => {}, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await assert.doesNotReject(() => plugin._refreshResources());
    assert.strictEqual(plugin._resources.length, 1, 'stale _resources must be preserved on a failed fetch');
  });

  it('fires exactly one trailing refresh when called again while a fetch is in flight', async () => {
    const plugin = makePlugin(['reviewer']);
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    wireOverrideIndicatorStubs(plugin);
    let callCount = 0;
    /** @type {(value: {resources: any[]}) => void} */
    let resolveFirst;
    const staleResources = [{ kind: 'schema', url: 'stale', key: 'stale', label: 'Stale', format: 'xml' }];
    const freshResources = [{ kind: 'schema', url: 'fresh', key: 'fresh', label: 'Fresh', format: 'xml' }];
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: {
        documentRulesList: () => {
          callCount++;
          if (callCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
          return Promise.resolve({ resources: freshResources });
        },
        documentRulesSelections: async ({ resources }) => ({
          selections: resources.map(r => ({ kind: r.kind, url: r.url, selected: false }))
        }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    const first = plugin._refreshResources();
    // These join the in-flight fetch (dedup) rather than starting new ones,
    // but each marks _refreshQueued - only one trailing refresh should fire
    // regardless of how many calls arrived while the fetch was busy.
    const second = plugin._refreshResources();
    const third = plugin._refreshResources();
    assert.strictEqual(callCount, 1, 'expected the in-flight fetch to be reused, not re-triggered');

    resolveFirst({ resources: staleResources });
    await Promise.all([first, second, third]);
    // The trailing refresh is itself fire-and-forget (kicked off from
    // _refreshResources()'s finally block without an await), so let it settle too.
    if (plugin._refreshPromise) await plugin._refreshPromise;
    await flushMicrotasks();

    assert.strictEqual(callCount, 2, 'expected exactly one trailing refresh, not one per queued call');
    assert.deepStrictEqual(plugin._resources, freshResources);
  });
});

describe('DocumentRulesPlugin._refreshOverrideIndicators', () => {
  it('shows the headerbar widget when at least one resource is selected', async () => {
    const plugin = makePlugin();
    plugin._overridesWidget = makeOverridesWidgetStub(false, 'w1');
    plugin._refDecorationSlot = { reconfigure: () => {} };
    plugin._resources = [{ kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' }];
    let added;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { addHeaderbarWidget: (w) => { added = w; w.isConnected = true; }, removeHeaderbarWidget: () => {} };
      if (name === 'client') return { apiClient: { documentRulesSelections: async () => ({ selections: [{ kind: 'interpretation-ref', url: 'u', selected: true }] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshOverrideIndicators();
    assert.strictEqual(added, plugin._overridesWidget);
  });

  it('hides the headerbar widget when nothing is selected', async () => {
    const plugin = makePlugin();
    plugin._overridesWidget = makeOverridesWidgetStub(true, 'w1');
    plugin._refDecorationSlot = { reconfigure: () => {} };
    plugin._resources = [{ kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' }];
    let removedId;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { addHeaderbarWidget: () => {}, removeHeaderbarWidget: (id) => { removedId = id; } };
      if (name === 'client') return { apiClient: { documentRulesSelections: async () => ({ selections: [{ kind: 'interpretation-ref', url: 'u', selected: false }] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshOverrideIndicators();
    assert.strictEqual(removedId, 'w1');
  });

  it('hides the widget and skips the fetch when there are no resources', async () => {
    const plugin = makePlugin();
    plugin._overridesWidget = makeOverridesWidgetStub(true, 'w1');
    plugin._refDecorationSlot = { reconfigure: () => {} };
    plugin._resources = [];
    let removedId, fetchCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { addHeaderbarWidget: () => {}, removeHeaderbarWidget: (id) => { removedId = id; } };
      if (name === 'client') return { apiClient: { documentRulesSelections: async () => { fetchCalled = true; return { selections: [] }; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshOverrideIndicators();
    assert.strictEqual(removedId, 'w1');
    assert.strictEqual(fetchCalled, false);
  });
});

describe('DocumentRulesPlugin._onOverridesWidgetClick', () => {
  it('unfolds the TEI header and reveals editorialDecl', () => {
    const plugin = makePlugin();
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return {
        unfoldByXpath: (xp) => calls.push(['unfold', xp]),
        selectByXpath: (xp) => calls.push(['select', xp]),
      };
      throw new Error(`unexpected dependency: ${name}`);
    };
    plugin._onOverridesWidgetClick();
    assert.deepStrictEqual(calls, [['unfold', '//tei:teiHeader'], ['select', '//tei:editorialDecl']]);
  });

  it('logs a warning and does not throw when the xmleditor calls fail', () => {
    const plugin = makePlugin();
    let warned = false;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return {
        unfoldByXpath: () => { throw new Error('no such node'); },
        selectByXpath: () => {},
      };
      if (name === 'logger') return { warn: () => { warned = true; }, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    assert.doesNotThrow(() => plugin._onOverridesWidgetClick());
    assert.strictEqual(warned, true);
  });
});

describe('DocumentRulesPlugin.onEditorReadOnlyChange', () => {
  it('makes the dialog read-only and hides content-editing controls even with an override selected', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (t) => t };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';

    plugin.onEditorReadOnlyChange(true);

    assert.strictEqual(plugin._documentReadOnly, true);
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, true);
    assert.strictEqual(plugin._editorDialogUi.newOverrideBtn.disabled, true);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, 'none');
  });

  it('does nothing to the dialog when no resource is currently open', () => {
    const plugin = makePlugin();
    assert.doesNotThrow(() => plugin.onEditorReadOnlyChange(true));
    assert.strictEqual(plugin._documentReadOnly, true);
  });

  it('restores editability when the document becomes writable again, for a selected override', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (t) => t };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin.onEditorReadOnlyChange(true);

    plugin.onEditorReadOnlyChange(false);

    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, false);
    assert.strictEqual(plugin._editorDialogUi.newOverrideBtn.disabled, false);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, '');
  });
});

describe('DocumentRulesPlugin._refreshRefDecorations', () => {
  it('reconfigures the decoration slot including both interpretation-ref and schema selections', () => {
    const plugin = makePlugin();
    let reconfigured;
    plugin._refDecorationSlot = { reconfigure: (ext) => { reconfigured = ext; } };
    plugin._selections = [
      { kind: 'interpretation-ref', url: 'https://example.com/a.md', selected: true },
      { kind: 'interpretation-ref', url: 'https://example.com/b.md', selected: false },
      { kind: 'schema', url: 'https://example.com/s.rng', selected: true },
    ];
    plugin._refreshRefDecorations();
    assert.ok(Array.isArray(reconfigured));
    assert.strictEqual(reconfigured.length, 3);
  });

  it('looks up related_urls without throwing when a selected resource has a machine ref', () => {
    const plugin = makePlugin();
    let reconfigured;
    plugin._refDecorationSlot = { reconfigure: (ext) => { reconfigured = ext; } };
    plugin._resources = [{
      kind: 'interpretation-ref', url: 'https://example.com/a.md#intro', key: 'a', label: 'A', format: 'markdown',
      related_urls: ['https://example.com/a.md#intro', 'https://example.com/a.md#L1-L10'],
    }];
    plugin._selections = [
      { kind: 'interpretation-ref', url: 'https://example.com/a.md#intro', selected: true },
    ];
    plugin._refreshRefDecorations();
    assert.ok(Array.isArray(reconfigured));
    assert.strictEqual(reconfigured.length, 3);
  });
});

describe('DocumentRulesPlugin._onRefDecorationClick', () => {
  it('opens the resource editor for the matching interpretation-ref resource', () => {
    const plugin = makePlugin();
    const resource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._resources = [resource];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._onRefDecorationClick('https://example.com/a.md');
    assert.deepStrictEqual(opened, resource);
  });

  it('opens the resource editor when the url matches a related_urls entry, not the primary url', () => {
    const plugin = makePlugin();
    const resource = {
      kind: 'interpretation-ref', url: 'https://example.com/a.md#intro', key: 'a', label: 'A', format: 'markdown',
      related_urls: ['https://example.com/a.md#intro', 'https://example.com/a.md#L1-L10'],
    };
    plugin._resources = [resource];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._onRefDecorationClick('https://example.com/a.md#L1-L10');
    assert.deepStrictEqual(opened, resource);
  });

  it('opens the resource editor for a matching schema resource (the xml-model href)', () => {
    const plugin = makePlugin();
    const resource = { kind: 'schema', url: 'https://example.com/schema.rng', key: 'schema', label: 'Schema (RelaxNG)', format: 'xml' };
    plugin._resources = [resource];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._onRefDecorationClick('https://example.com/schema.rng');
    assert.deepStrictEqual(opened, resource);
  });

  it('logs a warning and does nothing when no matching resource is cached', () => {
    const plugin = makePlugin();
    plugin._resources = [];
    let warned = false;
    plugin.getDependency = (name) => {
      if (name === 'logger') return { warn: () => { warned = true; }, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    let opened = false;
    plugin._openResourceEditor = () => { opened = true; };
    plugin._onRefDecorationClick('https://example.com/unknown.md');
    assert.strictEqual(opened, false);
    assert.strictEqual(warned, true);
  });
});

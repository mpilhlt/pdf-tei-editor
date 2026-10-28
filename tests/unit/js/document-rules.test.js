#!/usr/bin/env node

/**
 * Unit tests for the document-rules plugin (Edit document rules submenu,
 * resource editor dialog, Refresh document rules action).
 * @testCovers app/src/plugins/document-rules.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Text } from '@codemirror/state';
import { getOriginalDoc } from '@codemirror/merge';

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
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
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
// A real EditorView (see the _createMergeView test) needs these as well
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;

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
        'document-rules-update-dialog': readTemplate('document-rules-update-dialog.html'),
        'document-rules-propose-dialog': readTemplate('document-rules-propose-dialog.html'),
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
const { withKeyPrompt } = await import('../../../app/src/modules/secret-required.js');

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
  const editPanel = { updateComplete: Promise.resolve() };
  const previewPanel = { previewContent: document.createElement('div'), updateComplete: Promise.resolve() };
  // Real <sl-tab-group>.show(panelName) synchronously sets the matching
  // panel's `active` property (see SlTabGroup's setActiveTab()) -
  // _openResourceEditor() calls this directly to force the "Edit" tab
  // active rather than relying on the tab group's own default-active-tab
  // logic (a one-shot IntersectionObserver callback - see that method's
  // doc comment on why that races with a freshly opened dialog).
  const textTabs = Object.assign(document.createElement('sl-tab-group'), {
    editPanel, previewPanel, show: () => {},
  });
  el.textBody = Object.assign(document.createElement('div'), { textTabs });
  // Real <sl-tab-group>.show(panelName) emits `sl-tab-show` for the newly
  // active tab - recorded here so tests can assert which layer tab
  // _openResourceEditor() activates.
  el.layerTabs = Object.assign(document.createElement('sl-tab-group'), {
    humanLayerTab: document.createElement('sl-tab'),
    machineLayerTab: document.createElement('sl-tab'),
    shown: [],
  });
  el.layerTabs.show = (panel) => { el.layerTabs.shown.push(panel); };
  el.syncStatus = document.createElement('div');
  el.syncStatus.style.display = 'none';
  el.xmlBody = Object.assign(document.createElement('div'), { xmlContainer: document.createElement('div') });
  el.newOverrideBtn = document.createElement('sl-button');
  el.saveBtn = document.createElement('sl-button');
  el.deleteBtn = document.createElement('sl-button');
  el.resetBtn = document.createElement('sl-button');
  el.proposeUpstreamBtn = document.createElement('sl-button');
  el.updateFromGuideBtn = document.createElement('sl-button');
  el.closeBtn = document.createElement('sl-button');
  el.open = false;
  // Real <sl-dialog>.show() sets `open` and resolves once shown (see
  // dialog.component's handleOpenChange()/waitForEvent(this, 'sl-after-show'))
  // - _openResourceEditor() awaits it before re-scrolling.
  el.show = async () => { el.open = true; };
  return el;
}

/**
 * A minimal stand-in for `_proposeDialogUi`, mirroring the named parts of
 * document-rules-propose-dialog.html.
 * @returns {any}
 */
function makeProposeDialogUi() {
  const el = document.createElement('div');
  el.includeHuman = Object.assign(document.createElement('sl-checkbox'), { checked: false });
  el.includeMachine = Object.assign(document.createElement('sl-checkbox'), { checked: false });
  el.notice = document.createElement('div');
  el.notice.style.display = 'none';
  el.files = document.createElement('div');
  el.prSection = document.createElement('div');
  el.prSection.style.display = 'none';
  el.prSection.prTitle = Object.assign(document.createElement('sl-input'), { value: '' });
  el.prSection.prBody = Object.assign(document.createElement('sl-textarea'), { value: '' });
  el.prSection.prResult = document.createElement('div');
  el.prSection.append(el.prSection.prTitle, el.prSection.prBody, el.prSection.prResult);
  el.hint = document.createElement('div');
  el.createPrBtn = Object.assign(document.createElement('sl-button'), { disabled: true });
  el.createPrBtn.style.display = 'none';
  el.downloadBtn = Object.assign(document.createElement('sl-button'), { disabled: true });
  el.closeBtn = document.createElement('sl-button');
  el.open = false;
  el.show = async () => { el.open = true; };
  el.hide = async () => { el.open = false; };
  return el;
}

/**
 * A minimal stand-in for the xmleditor dependency's DOM-mutation surface
 * (`getDomNodesByXpath`/`updateEditorFromNode`/`saveIfDirty`), tracking
 * calls so tests can assert the exact sequence _onReset() makes for an
 * interpretation-ref resource. `nodesByXpath` maps an xpath string to the
 * array of fake DOM elements it should return.
 * @param {Record<string, Element[]>} nodesByXpath
 * @returns {{ mock: any, calls: string[] }}
 */
function makeXmlEditorMock(nodesByXpath = {}) {
  const calls = [];
  const mock = {
    saveIfDirty: async () => { calls.push('saveIfDirty'); },
    getDomNodesByXpath: (xpath) => { calls.push(`getDomNodesByXpath:${xpath}`); return nodesByXpath[xpath] ?? []; },
    updateEditorFromNode: async (node) => { calls.push(`updateEditorFromNode:${node.getAttribute('target')}`); },
  };
  return { mock, calls };
}

/**
 * A fake live DOM <ref> element with a mutable `target` attribute, for
 * asserting _onReset()'s setAttribute() + updateEditorFromNode() sequence.
 * @param {string} target
 * @returns {Element}
 */
function makeRefElement(target) {
  const el = document.createElementNS('http://www.tei-c.org/ns/1.0', 'ref');
  el.setAttribute('target', target);
  return el;
}

/**
 * A minimal but functionally real stand-in for `_cmMdView` (the markdown
 * CodeMirror instance that replaced a plain `<sl-textarea>` - see
 * _setMarkdownContent()'s doc comment on why). Unlike a full
 * `new EditorView(...)` (see e.g. xml-tag-sync.test.js), this needs no live
 * DOM/layout - jsdom can't measure real pixel geometry anyway, which is
 * exactly why the production code moved to CodeMirror's own line-aware
 * `EditorView.scrollIntoView()` effect instead of computing a pixel offset
 * by hand. `.state.doc` is a REAL `@codemirror/state` `Text`, so
 * `.line(n)`/`.length`/`.lines`/`.toString()` behave exactly like
 * production, and `.dispatch()` really applies `changes` to that doc, so
 * `_currentShownText()`/`_setMarkdownContent()` round-trip correctly.
 * `dispatched` records every dispatch call for assertions; `onScroll` (if
 * given) fires with the `ScrollTarget` value of any dispatched
 * `EditorView.scrollIntoView()` effect (see lastScrollTarget()) - both
 * `.range`/`.y` are plain data on that effect, not view-dependent, so they
 * can be asserted on without a live view.
 * @param {string} [text]
 * @param {{ onScroll?: (target: any) => void }} [options]
 * @returns {any}
 */
function makeCmMdViewMock(text = '', { onScroll } = {}) {
  let doc = Text.of(text.split('\n'));
  const dispatched = [];
  const view = {
    get state() { return { doc }; },
    dispatch(spec) {
      dispatched.push(spec);
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        const full = doc.toString();
        doc = Text.of((full.slice(0, from) + insert + full.slice(to)).split('\n'));
      }
      if (onScroll) {
        const target = lastScrollTarget([spec]);
        if (target) onScroll(target);
      }
    },
    scrollDOM: { scrollTop: 0 },
    dispatched,
    // Test convenience for simulating a user edit in the "Edit" tab -
    // production code never calls this itself, only real CM transactions.
    setText(newText) { doc = Text.of(newText.split('\n')); },
  };
  return view;
}

/**
 * Finds the `ScrollTarget` value of the last dispatched
 * `EditorView.scrollIntoView()` effect among `dispatchedSpecs` (each a
 * `dispatch()` call's argument), distinguishing it from the read-only/
 * history `Compartment.reconfigure()` effects `_setMarkdownContent()` also
 * dispatches by its distinctive `{range, y}` shape (see
 * @codemirror/view's `ScrollTarget` class) - or `null` if none is found.
 * @param {any[]} dispatchedSpecs
 * @returns {{range: {from: number, to: number}, y: string}|null}
 */
function lastScrollTarget(dispatchedSpecs) {
  for (let i = dispatchedSpecs.length - 1; i >= 0; i--) {
    const effects = dispatchedSpecs[i]?.effects;
    if (!effects) continue;
    const arr = Array.isArray(effects) ? effects : [effects];
    for (const effect of arr) {
      if (effect?.value?.range && typeof effect.value.y !== 'undefined') return effect.value;
    }
  }
  return null;
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
    assert.deepStrictEqual(plugin.deps, ['client', 'tools', 'xmleditor', 'dialog', 'services', 'logger', 'inference-settings', 'api-keys']);
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
    // _setMarkdownContent()/_scrollMarkdownBodyToAnchor() (which drive the
    // real CodeMirror view) aren't under test here - spied out like
    // _setXmlContent is elsewhere, isolating this test to _renderEditorDialog()'s
    // own selection/note/button logic. See "DocumentRulesPlugin scroll
    // position on render" for dedicated coverage of the real scroll math.
    let setMdArgs;
    plugin._setMarkdownContent = (...args) => { setMdArgs = args; };
    plugin._scrollMarkdownBodyToAnchor = () => {};
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
    assert.deepStrictEqual(setMdArgs, ['override text', false]);
    assert.strictEqual(notifyCalls[0][0], 'Override 1 selected for A.');
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
    let setMdArgs;
    plugin._setMarkdownContent = (...args) => { setMdArgs = args; };
    plugin._scrollMarkdownBodyToAnchor = () => {};
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    wireOverrideIndicatorStubs(plugin);
    plugin.getDependency = () => ({ apiClient: { documentRulesSelection: async () => {} } });

    await plugin._selectOverride(null);

    assert.deepStrictEqual(setMdArgs, ['original text', true]);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, 'none');
    assert.strictEqual(plugin._editorDialogUi.noteInput.style.display, 'none');
    assert.strictEqual(notifyCalls[0][0], 'Original selected for A.');
  });
});

describe('DocumentRulesPlugin format-based body swap', () => {
  it('shows the text body and hides the xml body for a markdown resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock();
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
    plugin._cmMdView = makeCmMdViewMock();
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

  it('resets the markdown edit view and preview to the top when the resource has no heading-anchor fragment', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'some text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent.scrollTop = 500;

    plugin._renderEditorDialog();

    const target = lastScrollTarget(plugin._cmMdView.dispatched);
    assert.strictEqual(target.range.from, 0);
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent.scrollTop, 0);
  });

  it('does not scroll past the top for a line-range fragment (already sliced server-side, nothing to locate)', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md#L5-L10', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'line1\nline2\nline3\n';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    plugin._renderEditorDialog();

    const target = lastScrollTarget(plugin._cmMdView.dispatched);
    assert.strictEqual(target.range.from, 0);
  });

  it('scrolls the edit view and preview to the heading matching a "human" ref\'s heading-anchor fragment (e.g. "#data-correction")', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock();
    plugin._md = createMarkdownRenderer();
    plugin._currentResource = {
      kind: 'interpretation-ref',
      url: 'https://example.com/guidelines.md#data-correction',
      key: 'a', label: 'Data correction', format: 'markdown'
    };
    const text = '# Guidelines\n\nIntro.\n\n## Data correction\n\nBody text.\n';
    plugin._currentOriginalText = text;
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    plugin._renderEditorDialog();

    // "## Data correction" is on line 5 (1-based) - CodeMirror's own
    // EditorView.scrollIntoView() effect targets that line's start
    // position directly, not a hand-computed pixel offset (see
    // _scrollMarkdownBodyToAnchor()'s doc comment on why: a plain
    // `<sl-textarea>`'s `(line - 1) * lineHeight` math silently broke once
    // lines wrapped).
    const target = lastScrollTarget(plugin._cmMdView.dispatched);
    assert.strictEqual(target.range.from, Text.of(text.split('\n')).line(5).from);
    assert.strictEqual(target.y, 'start');

    const previewContent = plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent;
    assert.ok(previewContent.querySelector('#data-correction'), 'preview must render a heading with the matching id');
  });

  it('does not scroll to a fragment for a non-markdown resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock();
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.txt#data-correction', key: 'a', label: 'A', format: 'text' };
    plugin._currentOriginalText = 'plain text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;

    plugin._renderEditorDialog();

    const target = lastScrollTarget(plugin._cmMdView.dispatched);
    assert.strictEqual(target.range.from, 0);
  });
});

describe('DocumentRulesPlugin._openResourceEditor', () => {
  it('scrolls to the heading-anchor fragment only after the dialog has actually been shown', async () => {
    // Regression test: _renderEditorDialog() runs while the dialog is still
    // hidden (`<sl-dialog>` only becomes visible once show() resolves), and
    // setting scroll position on a hidden element has no effect in a real
    // browser - the fix defers the scroll call until after show() resolves.
    // This is a timing/ordering check, since the jsdom mock below can't
    // reproduce the browser's "hidden element ignores scrollTop" behavior
    // directly - see makeDialogUi()'s show() stub.
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = createMarkdownRenderer();
    const text = '# Guidelines\n\nIntro.\n\n## Data correction\n\nBody text.\n';
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesQuery: async () => ({ overrides: [], selected_override_id: null, original_text: text }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    const calls = [];
    plugin._cmMdView = makeCmMdViewMock('', { onScroll: (target) => calls.push(['scroll', target.range.from]) });
    plugin._editorDialogUi.show = async () => { calls.push(['show']); plugin._editorDialogUi.open = true; };
    plugin._editorDialogUi.textBody.textTabs.show = (panel) => calls.push(['show-tab', panel]);

    const resource = {
      kind: 'interpretation-ref', url: 'https://example.com/guidelines.md#data-correction',
      key: 'a', label: 'Data correction', format: 'markdown',
    };
    await plugin._openResourceEditor(resource);

    // "## Data correction" is on line 5 (1-based) - and it must come
    // strictly after 'show' and 'show-tab', not before. The "edit" tab must
    // be forced active explicitly rather than trusting the tab group's own
    // default-active-tab logic, which races with a freshly opened dialog -
    // see _openResourceEditor()'s doc comment.
    assert.deepStrictEqual(calls, [['show'], ['show-tab', 'edit'], ['scroll', Text.of(text.split('\n')).line(5).from]]);
  });

  it('awaits the "edit" panel\'s own pending update before scrolling, not just the dialog\'s show()', async () => {
    // Regression test for the IntersectionObserver race described in
    // _openResourceEditor()'s doc comment: forcing the tab active (show())
    // only *schedules* the panel's `active` attribute reflection - real
    // @shoelace-style/shoelace panels apply it asynchronously, via their own
    // Lit update cycle, not synchronously inside show(). If the code scrolled
    // right after show('edit') without awaiting editPanel.updateComplete,
    // this test's deliberately-delayed updateComplete would still be
    // pending when scrollPosition() is called.
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (text) => text };
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesQuery: async () => ({ overrides: [], selected_override_id: null, original_text: 'plain text' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    let updateResolved = false;
    plugin._cmMdView = makeCmMdViewMock('', { onScroll: () => { scrolledAfterUpdate = updateResolved; } });
    plugin._editorDialogUi.textBody.textTabs.editPanel.updateComplete = new Promise((resolve) => {
      setImmediate(() => { updateResolved = true; resolve(); });
    });
    let scrolledAfterUpdate = null;

    const resource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    await plugin._openResourceEditor(resource);

    assert.strictEqual(scrolledAfterUpdate, true);
  });

  it('does not scroll a non-markdown (schema/xml) resource after showing the dialog', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmView = { state: { doc: { length: 0 } }, dispatch: () => {}, scrollDOM: { scrollTop: 0 } };
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesQuery: async () => ({ overrides: [], selected_override_id: null, original_text: '<grammar/>' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    const resource = { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml' };
    await plugin._openResourceEditor(resource);

    // _cmMdView is never touched for an xml-format resource - left
    // unassigned (null) so any wrong access here would throw instead of
    // silently no-op.
    assert.strictEqual(plugin._cmMdView, null);
  });
});

describe('DocumentRulesPlugin._onNewOverride/_onSave/_onDelete/_onReset', () => {
  function setup() {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock('original text');
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
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

  it('_onNewOverride shows the new override in the row even when selecting it fails', async () => {
    const plugin = setup();
    const created = { id: 'ov1', note: '', text: 'original text', format: 'markdown', created_at: '', updated_at: '' };
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesOverrides: async () => created,
        documentRulesSelection: async () => { throw new Error('selection failed'); },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onNewOverride();
    assert.strictEqual(plugin._currentSelectedId, null);
    const labels = [...plugin._editorDialogUi.overrideRow.children].map(b => b.textContent);
    assert.deepStrictEqual(labels, ['Original', 'Override 1']);
    assert.match(notifyCalls[0][0], /selection failed/);
  });

  it('_onSave persists the note and shown text for the selected override, rebased on the shown resource', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: 'old note', text: 'old text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin._editorDialogUi.noteInput.value = 'new note';
    plugin._cmMdView.setText('new text');
    const updated = { id: 'ov1', note: 'new note', text: 'new text', format: 'markdown', created_at: '', updated_at: '' };
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesUpdateOverrides: async (id, body) => { calls.push([id, body]); return updated; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onSave();
    assert.deepStrictEqual(calls, [['ov1', { note: 'new note', text: 'new text', fragment_url: 'https://example.com/a.md' }]]);
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

  it('_onReset (schema kind) keeps the simple delete-and-requery behavior, no document edit', async () => {
    const plugin = setup();
    // _renderEditorDialog() routes a 'xml'-format resource through
    // _setXmlContent(), which drives the real CodeMirror view - not set up
    // by this describe block's setup() (see the pattern already used by
    // the 'shows the xml body...' test in the format-based body swap
    // describe block above).
    plugin._setXmlContent = () => {}
    plugin._currentResource = { kind: 'schema', url: 'https://example.com/schema.rng', key: 's', label: 'Schema', format: 'xml' };
    plugin._currentOverrides = [
      { id: 'ov1', note: '', text: 'x', format: 'xml', created_at: '', updated_at: '' },
      { id: 'ov2', note: '', text: 'y', format: 'xml', created_at: '', updated_at: '' },
    ];
    plugin._currentSelectedId = 'ov1';
    const deletedIds = [];
    let queryCalledWith;
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock();
    const freshResponse = { original_text: 'fresh from origin', overrides: [], selected_override_id: null };
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async (body) => { queryCalledWith = body; return freshResponse; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.deepStrictEqual(deletedIds, ['ov1', 'ov2']);
    assert.deepStrictEqual(queryCalledWith, { kind: 'schema', url: 'https://example.com/schema.rng' });
    assert.strictEqual(plugin._currentOriginalText, 'fresh from origin');
    assert.deepStrictEqual(plugin._currentOverrides, []);
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.deepStrictEqual(xmlCalls, []);
  });

  it('_onReset does nothing when the confirmation is declined', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deleteCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => false };
      if (name === 'client') return { apiClient: { documentRulesDeleteOverrides: async () => { deleteCalled = true; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.strictEqual(deleteCalled, false);
    assert.strictEqual(plugin._currentOverrides.length, 1);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
  });

  it('_onReset (interpretation-ref, changed=true) updates the document ref, then deletes overrides, then re-queries the new url', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/oldsha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/oldsha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const refEl = makeRefElement('https://github.com/o/r/blob/oldsha/docs/g.md#seg');
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock({
      '//tei:editorialDecl//tei:ref[@subtype="human"]': [refEl],
    });
    const deletedIds = [];
    let queryCalledWith;
    let refreshCalledWith;
    const freshResponse = { original_text: 'fresh new text', overrides: [], selected_override_id: null };
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async (body) => {
          refreshCalledWith = body;
          return {
            status: 'ok', changed: true,
            refs: [{ target: 'https://github.com/o/r/blob/newsha/docs/g.md#seg', content_type: 'markdown', subtype: 'human' }],
            message: 'Resource refreshed from upstream.',
          };
        },
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async (body) => { queryCalledWith = body; return freshResponse; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();

    assert.deepStrictEqual(refreshCalledWith, { xml: 'stable123', url: 'https://github.com/o/r/blob/oldsha/docs/g.md#seg' });
    assert.deepStrictEqual(xmlCalls, [
      'saveIfDirty',
      'getDomNodesByXpath://tei:editorialDecl//tei:ref[@subtype="human"]',
      'updateEditorFromNode:https://github.com/o/r/blob/newsha/docs/g.md#seg',
      'saveIfDirty',
    ]);
    assert.strictEqual(refEl.getAttribute('target'), 'https://github.com/o/r/blob/newsha/docs/g.md#seg');
    assert.deepStrictEqual(deletedIds, ['ov1']);
    assert.deepStrictEqual(queryCalledWith, { kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/newsha/docs/g.md#seg' });
    assert.strictEqual(plugin._currentResource.url, 'https://github.com/o/r/blob/newsha/docs/g.md#seg');
    assert.deepStrictEqual(plugin._currentResource.related_urls, ['https://github.com/o/r/blob/newsha/docs/g.md#seg']);
    assert.strictEqual(plugin._currentOriginalText, 'fresh new text');
    assert.match(notifyCalls[0][0], /refreshed from upstream and removed all overrides/);
  });

  it('_onReset (interpretation-ref with human and machine refs) switches to the refreshed machine ref, which overrides target', async () => {
    const plugin = setup();
    const oldHuman = 'https://github.com/o/r/blob/oldsha/docs/g.md#seg';
    const oldMachine = 'https://github.com/o/r/blob/oldsha/docs/g.md#L3-L9';
    const newHuman = 'https://github.com/o/r/blob/newsha/docs/g.md#seg';
    const newMachine = 'https://github.com/o/r/blob/newsha/docs/g.md#L4-L10';
    plugin._currentResource = {
      kind: 'interpretation-ref', url: oldMachine, key: 'k', label: 'Guide',
      format: 'markdown', related_urls: [oldHuman, oldMachine],
    };
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    const { mock: xmleditorMock } = makeXmlEditorMock({
      '//tei:editorialDecl//tei:ref[@subtype="human"]': [makeRefElement(oldHuman)],
      '//tei:editorialDecl//tei:ref[@subtype="machine"]': [makeRefElement(oldMachine)],
    });
    let queryCalledWith;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async () => ({
          status: 'ok', changed: true,
          refs: [
            { target: newHuman, content_type: 'markdown', subtype: 'human' },
            { target: newMachine, content_type: 'markdown', subtype: 'machine' },
          ],
          message: 'Resource refreshed from upstream.',
        }),
        documentRulesDeleteOverrides: async () => {},
        documentRulesQuery: async (body) => { queryCalledWith = body; return { original_text: 't', overrides: [], selected_override_id: null }; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();

    assert.strictEqual(plugin._currentResource.url, newMachine);
    assert.deepStrictEqual(queryCalledWith, { kind: 'interpretation-ref', url: newMachine });
  });

  it('_onReset (interpretation-ref, changed=true, refs=[]) does not throw and leaves the url unchanged', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock();
    const deletedIds = [];
    let queryCalledWith;
    const freshResponse = { original_text: 'same text', overrides: [], selected_override_id: null };
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async () => ({ status: 'ok', changed: true, refs: [], message: 'Resource refreshed from upstream.' }),
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async (body) => { queryCalledWith = body; return freshResponse; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await assert.doesNotReject(plugin._onReset());

    assert.deepStrictEqual(xmlCalls, ['saveIfDirty', 'saveIfDirty']);
    assert.strictEqual(plugin._currentResource.url, 'https://github.com/o/r/blob/sha/docs/g.md#seg');
    assert.deepStrictEqual(plugin._currentResource.related_urls, ['https://github.com/o/r/blob/sha/docs/g.md#seg']);
    assert.deepStrictEqual(deletedIds, ['ov1']);
    assert.deepStrictEqual(queryCalledWith, { kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg' });
    assert.strictEqual(plugin._currentOriginalText, 'same text');
  });

  it('_onReset (interpretation-ref, changed=false) skips the DOM edit but still deletes overrides', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock();
    const deletedIds = [];
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async () => ({ status: 'ok', changed: false, refs: [], message: 'Resource is already up to date.' }),
        documentRulesDeleteOverrides: async (id) => { deletedIds.push(id); },
        documentRulesQuery: async () => ({ original_text: 'same text', overrides: [], selected_override_id: null }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.deepStrictEqual(xmlCalls, []);
    assert.deepStrictEqual(deletedIds, ['ov1']);
    assert.match(notifyCalls[0][0], /overrides removed \(already up to date\)/);
  });

  for (const status of ['unavailable', 'orphaned']) {
    it(`_onReset (interpretation-ref, status=${status}) warns and does nothing else`, async () => {
      const plugin = setup();
      plugin._currentResource = {
        kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
        format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
      };
      plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
      plugin._currentSelectedId = 'ov1';
      let deleteCalled = false;
      let queryCalled = false;
      plugin.getDependency = (name) => {
        if (name === 'dialog') return { confirm: async () => true };
        if (name === 'client') return { apiClient: {
          documentRulesRefreshResource: async () => ({ status, changed: false, refs: [], message: `${status} message` }),
          documentRulesDeleteOverrides: async () => { deleteCalled = true; },
          documentRulesQuery: async () => { queryCalled = true; },
        } };
        throw new Error(`unexpected dependency: ${name}`);
      };
      await plugin._onReset();
      assert.strictEqual(deleteCalled, false);
      assert.strictEqual(queryCalled, false);
      assert.strictEqual(plugin._currentOverrides.length, 1);
      assert.match(notifyCalls[0][0], new RegExp(`${status} message`));
      assert.strictEqual(notifyCalls[0][1], 'warning');
    });
  }

  it('_onReset (interpretation-ref, status=not_found) shows a danger toast', async () => {
    const plugin = setup();
    plugin._currentResource = {
      kind: 'interpretation-ref', url: 'https://github.com/o/r/blob/sha/docs/g.md#seg', key: 'k', label: 'Guide',
      format: 'markdown', related_urls: ['https://github.com/o/r/blob/sha/docs/g.md#seg'],
    };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deleteCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshResource: async () => ({ status: 'not_found', changed: false, refs: [], message: 'gone' }),
        documentRulesDeleteOverrides: async () => { deleteCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.strictEqual(deleteCalled, false);
    assert.match(notifyCalls[0][0], /gone/);
    assert.strictEqual(notifyCalls[0][1], 'danger');
  });

  it('_onReset stops and notifies if deleting an override fails, without querying', async () => {
    const plugin = setup();
    plugin._currentResource = { kind: 'schema', url: 'https://example.com/schema.rng', key: 's', label: 'Schema', format: 'xml' };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'xml', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let queryCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'client') return { apiClient: {
        documentRulesDeleteOverrides: async () => { throw new Error('boom'); },
        documentRulesQuery: async () => { queryCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.strictEqual(queryCalled, false);
    assert.match(notifyCalls[0][0], /Could not remove overrides/);
  });
});

describe('DocumentRulesPlugin._onProposeUpstream', () => {
  function setup() {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock('shown text');
    plugin._md = { render: (text) => text };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'old text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
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

  it('confirms, then copies the backend-rewritten text to the clipboard and opens a prefilled tab', async () => {
    const plugin = setup();
    let calledWith;
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async (body) => {
        calledWith = body;
        return { url: 'https://github.com/mpilhlt/pdf-tei-editor/edit/main/rules.md?value=shown+text', content_prefilled: true, text: 'rewritten text' };
      },
    } });
    await plugin._onProposeUpstream();
    assert.deepStrictEqual(calledWith, { url: 'https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md', text: 'shown text' });
    assert.strictEqual(confirmCalls.length, 1);
    assert.match(confirmCalls[0][0], /prefilled/);
    // Copies response.text (the backend's derelativized version), not the
    // locally-read `text` sent in the request - a same-repo absolute link
    // this app resolved internally must not leak into the clipboard copy.
    assert.deepStrictEqual(clipboardCalls, ['rewritten text']);
    assert.deepStrictEqual(openCalls[0], ['https://github.com/mpilhlt/pdf-tei-editor/edit/main/rules.md?value=shown+text', '_blank', 'noopener']);
  });

  it('confirms with clipboard-fallback wording and opens an unprefilled tab when content_prefilled is false', async () => {
    const plugin = setup();
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => ({ url: 'https://gitlab.com/group/project/-/edit/main/rules.md', content_prefilled: false, text: 'rewritten text' }),
    } });
    await plugin._onProposeUpstream();
    assert.match(confirmCalls[0][0], /clipboard/);
    assert.deepStrictEqual(clipboardCalls, ['rewritten text']);
    assert.strictEqual(openCalls[0][0], 'https://gitlab.com/group/project/-/edit/main/rules.md');
  });

  it('does not copy or open anything when the user cancels the confirmation', async () => {
    const plugin = setup();
    confirmReturns = false;
    withDialog(plugin, { apiClient: {
      documentRulesProposeChangeUrl: async () => ({ url: 'https://gitlab.com/group/project/-/edit/main/rules.md', content_prefilled: false, text: 'rewritten text' }),
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
      documentRulesProposeChangeUrl: async () => ({ url: 'https://github.com/mpilhlt/pdf-tei-editor/edit/main/rules.md?value=shown+text', content_prefilled: true, text: 'rewritten text' }),
    } });
    await plugin._onProposeUpstream();
    assert.strictEqual(openCalls.length, 1);
  });
});

describe('DocumentRulesPlugin._renderEditorDialog proposeUpstreamBtn visibility', () => {
  it('is hidden when Original is selected and shown when an override is selected', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock();
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
  it('hides the refresh menu item for a user without reviewer/admin role, and also hides "Edit document rules" via the re-triggered resource refresh', async () => {
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
    let setMdArgs;
    plugin._setMarkdownContent = (...args) => { setMdArgs = args; };
    plugin._scrollMarkdownBodyToAnchor = () => {};
    plugin._md = { render: (t) => t };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';

    plugin.onEditorReadOnlyChange(true);

    assert.strictEqual(plugin._documentReadOnly, true);
    assert.deepStrictEqual(setMdArgs, ['override text', true]);
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
    let setMdArgs;
    plugin._setMarkdownContent = (...args) => { setMdArgs = args; };
    plugin._scrollMarkdownBodyToAnchor = () => {};
    plugin._md = { render: (t) => t };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin.onEditorReadOnlyChange(true);

    plugin.onEditorReadOnlyChange(false);

    assert.deepStrictEqual(setMdArgs, ['override text', false]);
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

describe('DocumentRulesPlugin layer tabs (Guide (human) / Machine rules)', () => {
  const human = {
    kind: 'interpretation-ref', url: 'https://example.com/g.md#primary', key: 'k', label: 'Primary',
    format: 'markdown', layer: 'human', group: 'interpretation-ref:primary', related_urls: ['https://example.com/g.md#primary'],
  };
  const machine = {
    kind: 'interpretation-ref', url: 'https://example.com/rules.md', key: 'k2', label: 'Primary',
    format: 'markdown', layer: 'machine', group: 'interpretation-ref:primary', related_urls: ['https://example.com/rules.md'],
  };
  const schema = { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml', layer: null, group: null };

  /**
   * @param {string[]} queried - receives every queried url
   * @returns {InstanceType<typeof DocumentRulesPlugin>}
   */
  function setup(queried) {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._cmMdView = makeCmMdViewMock('');
    plugin._cmView = { state: { doc: { length: 0 } }, dispatch: () => {}, scrollDOM: { scrollTop: 0 } };
    plugin._md = { render: (text) => text };
    plugin._resources = [{ ...human }, { ...machine }, { ...schema }];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesQuery: async (body) => { queried.push(body.url); return { overrides: [], selected_override_id: null, original_text: `text of ${body.url}` }; },
        documentRulesSyncStatus: async () => ({ status: 'in_sync', human_source: 'original', machine_source: 'original', base: null, synced_commit: null }),
      } };
      if (name === 'logger') return { warn: () => {}, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    return plugin;
  }

  it('_resourceGroups groups by group (or url when null), in first-seen order', () => {
    const plugin = setup([]);
    const groups = plugin._resourceGroups();
    assert.deepStrictEqual(groups.map(g => g.map(r => r.url)), [[human.url, machine.url], [schema.url]]);
  });

  it('_populateSubmenu shows one item for a two-layer group, opening its first descriptor', () => {
    const plugin = setup([]);
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._populateSubmenu();
    const items = [...plugin._editMenuItem.documentRulesEditSubmenu.children];
    assert.deepStrictEqual(items.map(i => i.textContent), ['Primary', 'Schema (RelaxNG)']);
    items[0].dispatchEvent(new dom.window.Event('click'));
    assert.strictEqual(opened, plugin._resources[0]);
  });

  it('opening a grouped resource shows layerTabs with the tab matching its layer', async () => {
    const plugin = setup([]);
    await plugin._openResourceEditor(plugin._resources[1]);
    assert.strictEqual(plugin._editorDialogUi.layerTabs.style.display, '');
    assert.deepStrictEqual(plugin._editorDialogUi.layerTabs.shown, ['machine']);
    assert.deepStrictEqual(plugin._currentGroup, [plugin._resources[0], plugin._resources[1]]);
  });

  it('opening a single-layer resource hides layerTabs', async () => {
    const plugin = setup([]);
    await plugin._openResourceEditor(plugin._resources[2]);
    assert.strictEqual(plugin._editorDialogUi.layerTabs.style.display, 'none');
    assert.deepStrictEqual(plugin._editorDialogUi.layerTabs.shown, []);
  });

  it('switching to the other layer tab queries that layer\'s url', async () => {
    const queried = [];
    const plugin = setup(queried);
    await plugin._openResourceEditor(plugin._resources[0]);
    await plugin._onLayerTabShow('machine');
    assert.deepStrictEqual(queried, [human.url, machine.url]);
    assert.strictEqual(plugin._currentResource, plugin._resources[1]);
    assert.strictEqual(plugin._currentOriginalText, `text of ${machine.url}`);
  });

  it('a tab-show for the already shown layer (programmatic select while opening) does not re-query', async () => {
    const queried = [];
    const plugin = setup(queried);
    await plugin._openResourceEditor(plugin._resources[0]);
    await plugin._onLayerTabShow('human');
    assert.deepStrictEqual(queried, [human.url]);
  });

  it('_onRefDecorationClick on the machine url opens the machine descriptor', () => {
    const plugin = setup([]);
    // Even when the human descriptor's related_urls also lists the machine url
    plugin._resources[0].related_urls = [human.url, machine.url];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._onRefDecorationClick(machine.url);
    assert.strictEqual(opened, plugin._resources[1]);
  });

  it('an outdated override button gets a clock icon and the outdated tooltip, with the note on a new line', () => {
    const plugin = setup([]);
    plugin._currentOverrides = [
      { id: 'a', note: 'my note', text: '', format: 'markdown', created_at: '', updated_at: '', outdated: true },
      { id: 'b', note: '', text: '', format: 'markdown', created_at: '', updated_at: '', outdated: false },
    ];
    plugin._currentSelectedId = null;
    plugin._renderOverrideRow();
    const [, outdatedBtn, freshBtn] = [...plugin._editorDialogUi.overrideRow.children];
    const icon = outdatedBtn.querySelector('sl-icon');
    assert.ok(icon);
    assert.strictEqual(icon.getAttribute('name'), 'clock-history');
    assert.strictEqual(icon.getAttribute('slot'), 'suffix');
    assert.strictEqual(outdatedBtn.title, 'Based on an older version of the original\nmy note');
    assert.strictEqual(freshBtn.querySelector('sl-icon'), null);
    assert.strictEqual(freshBtn.title, '');
  });

  it('_onReset on the human layer switches to the refreshed human ref and updates both group members', async () => {
    const queried = [];
    const plugin = setup(queried);
    const [h, m] = plugin._resources;
    plugin._currentResource = h;
    plugin._currentGroup = [h, m];
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    wireOverrideIndicatorStubs(plugin);
    const newHuman = 'https://example.com/g2.md#primary';
    const newMachine = 'https://example.com/rules2.md';
    const { mock: xmleditorMock, calls: xmlCalls } = makeXmlEditorMock({
      '//tei:editorialDecl//tei:ref[@subtype="human"]': [makeRefElement(human.url)],
      '//tei:editorialDecl//tei:ref[@subtype="machine"]': [makeRefElement(machine.url)],
    });
    const baseGetDependency = plugin.getDependency;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'xmleditor') return xmleditorMock;
      if (name === 'client') {
        const client = baseGetDependency('client');
        client.apiClient.documentRulesRefreshResource = async () => ({
          status: 'ok', changed: true, message: 'ok',
          refs: [
            { target: newHuman, content_type: 'markdown', subtype: 'human' },
            { target: newMachine, content_type: 'markdown', subtype: 'machine' },
          ],
        });
        client.apiClient.documentRulesDeleteOverrides = async () => {};
        client.apiClient.documentRulesSelections = async () => ({ selections: [] });
        return client;
      }
      return baseGetDependency(name);
    };
    await plugin._onReset();

    // Both layers' <ref>s are rewritten, although each descriptor only lists its own url
    assert.ok(xmlCalls.includes(`updateEditorFromNode:${newHuman}`));
    assert.ok(xmlCalls.includes(`updateEditorFromNode:${newMachine}`));
    assert.strictEqual(h.url, newHuman);
    assert.deepStrictEqual(h.related_urls, [newHuman]);
    assert.strictEqual(m.url, newMachine);
    assert.deepStrictEqual(m.related_urls, [newMachine]);
    assert.deepStrictEqual(queried, [newHuman]);
  });
});

describe('DocumentRulesPlugin sync status line', () => {
  const human = { kind: 'interpretation-ref', url: 'https://example.com/g.md#primary', key: 'k', label: 'Primary', format: 'markdown', layer: 'human', group: 'interpretation-ref:primary' };
  const machine = { kind: 'interpretation-ref', url: 'https://example.com/rules.md', key: 'k2', label: 'Primary', format: 'markdown', layer: 'machine', group: 'interpretation-ref:primary' };
  const schema = { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml', layer: null, group: null };

  /**
   * @param {(body: any) => Promise<any>} syncStatus - stand-in for apiClient.documentRulesSyncStatus
   * @returns {{ plugin: InstanceType<typeof DocumentRulesPlugin>, requests: any[], warnings: string[] }}
   */
  function setup(syncStatus) {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = human;
    plugin._currentGroup = [human, machine];
    const requests = [];
    const warnings = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesSyncStatus: async (body) => { requests.push(body); return syncStatus(body); } } };
      if (name === 'logger') return { warn: (msg) => { warnings.push(msg); }, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    return { plugin, requests, warnings };
  }

  /** @param {string} status */
  const response = (status, synced_commit = null) => ({ status, human_source: 'original', machine_source: 'original', base: null, synced_commit });

  it('is hidden for a single-layer group, without a request', async () => {
    const { plugin, requests } = setup(async () => response('in_sync'));
    plugin._currentResource = schema;
    plugin._currentGroup = [schema];
    plugin._editorDialogUi.syncStatus.style.display = '';
    await plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.style.display, 'none');
    assert.deepStrictEqual(requests, []);
  });

  const cases = [
    ['in_sync', 'In sync with the guide', 'check-circle'],
    ['machine_outdated', 'Machine rules outdated: the guide changed since the last sync', 'exclamation-triangle'],
    ['machine_edited', 'Machine rules edited by hand since the last sync', 'exclamation-triangle'],
    ['both_changed', 'Machine rules outdated and edited by hand', 'exclamation-triangle'],
    ['no_marker', 'No sync marker', 'exclamation-triangle'],
  ];
  for (const [status, text, icon] of cases) {
    it(`shows "${text}" for ${status}`, async () => {
      const { plugin, requests } = setup(async () => response(status));
      await plugin._refreshSyncStatus();
      const line = plugin._editorDialogUi.syncStatus;
      assert.deepStrictEqual(requests, [{ human_url: human.url, machine_url: machine.url }]);
      assert.strictEqual(line.style.display, '');
      assert.strictEqual(line.querySelector('sl-icon').getAttribute('name'), icon);
      assert.strictEqual(line.textContent.trim(), text);
    });
  }

  it('appends the short hash of the last sync commit', async () => {
    const { plugin } = setup(async () => response('in_sync', 'abc1234def5678'));
    await plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.textContent.trim(), 'In sync with the guide (last sync: abc1234)');
  });

  it('is refreshed after _selectOverride', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._setMarkdownContent = () => {};
    plugin._scrollMarkdownBodyToAnchor = () => {};
    plugin._md = { render: (text) => text };
    plugin._currentResource = human;
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = null;
    wireOverrideIndicatorStubs(plugin);
    plugin.getDependency = () => ({ apiClient: { documentRulesSelection: async () => {} } });
    let refreshed = 0;
    plugin._refreshSyncStatus = async () => { refreshed++; };
    await plugin._selectOverride('ov1');
    assert.strictEqual(refreshed, 1);
  });

  it('ignores a response that arrives after a newer request', async () => {
    let resolveFirst;
    let call = 0;
    const { plugin } = setup(() => {
      call++;
      if (call === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(response('in_sync'));
    });
    const first = plugin._refreshSyncStatus();
    await plugin._refreshSyncStatus();
    resolveFirst(response('no_marker'));
    await first;
    assert.strictEqual(plugin._editorDialogUi.syncStatus.textContent.trim(), 'In sync with the guide');
  });

  /**
   * A syncStatus stand-in that answers the first call with `in_sync` and
   * leaves every later call pending.
   * @returns {(body: any) => Promise<any>}
   */
  function firstResolvedThenPending() {
    let call = 0;
    return () => (++call === 1 ? Promise.resolve(response('in_sync')) : new Promise(() => {}));
  }

  it('hides the previous pair\'s status while the status of another pair loads', async () => {
    const { plugin } = setup(firstResolvedThenPending());
    await plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.style.display, '');
    const otherHuman = { ...human, url: 'https://example.com/g.md#secondary', group: 'interpretation-ref:secondary' };
    const otherMachine = { ...machine, url: 'https://example.com/rules2.md', group: 'interpretation-ref:secondary' };
    plugin._currentResource = otherHuman;
    plugin._currentGroup = [otherHuman, otherMachine];
    plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.style.display, 'none');
  });

  it('keeps the line visible while a layer-tab switch within the same pair reloads it', async () => {
    const { plugin } = setup(firstResolvedThenPending());
    await plugin._refreshSyncStatus();
    plugin._currentResource = machine;
    plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.style.display, '');
    assert.strictEqual(plugin._editorDialogUi.syncStatus.textContent.trim(), 'In sync with the guide');
  });

  it('shows the raw status when there is no copy for it', async () => {
    const { plugin } = setup(async () => response('something_new'));
    await plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.textContent.trim(), 'something_new');
  });

  it('hides the line and logs a warning when the request fails', async () => {
    const { plugin, warnings } = setup(async () => { throw new Error('boom'); });
    plugin._editorDialogUi.syncStatus.style.display = '';
    await plugin._refreshSyncStatus();
    assert.strictEqual(plugin._editorDialogUi.syncStatus.style.display, 'none');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /boom/);
  });
});

describe('DocumentRulesPlugin "Update from guide"', () => {
  const human = { kind: 'interpretation-ref', url: 'https://example.com/g.md#primary', key: 'k', label: 'Primary', format: 'markdown', layer: 'human', group: 'interpretation-ref:primary' };
  const machine = { kind: 'interpretation-ref', url: 'https://example.com/rules.md', key: 'k2', label: 'Primary', format: 'markdown', layer: 'machine', group: 'interpretation-ref:primary' };
  const schema = { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml', layer: null, group: null };

  const models = [
    { providerId: 'p1', modelId: 'm1', label: 'Provider 1/Model 1' },
    { providerId: 'p2', modelId: 'm2', label: 'Provider 2/Model 2' },
  ];

  const humanChange = { mode: 'delta', old_human: '# G\n\nold', new_human: '# G\n\nnew', machine: '# M\n\nrules', base_commit: 'abc', unchanged: false };

  /**
   * A minimal stand-in for `_updateDialogUi`, mirroring the named parts of
   * document-rules-update-dialog.html.
   * @returns {any}
   */
  function makeUpdateDialogUi() {
    const el = document.createElement('div');
    el.notice = document.createElement('div');
    el.notice.style.display = 'none';
    el.humanDiffHeading = document.createElement('div');
    el.humanDiff = document.createElement('div');
    el.modelRow = Object.assign(document.createElement('div'), {
      modelSelect: Object.assign(document.createElement('sl-select'), { value: '' }),
      generateBtn: document.createElement('sl-button'),
    });
    el.proposedHeading = document.createElement('div');
    el.proposedHeading.style.display = 'none';
    el.proposedDiff = document.createElement('div');
    el.proposedDiff.style.display = 'none';
    el.acceptBtn = Object.assign(document.createElement('sl-button'), { disabled: true });
    el.closeBtn = document.createElement('sl-button');
    el.open = false;
    el.show = async () => { el.open = true; };
    el.hide = async () => { el.open = false; };
    return el;
  }

  /**
   * @param {object} [options]
   * @param {Array<any>} [options.modelList] - what inference-settings' getModels() returns
   * @param {any} [options.defaultModel] - what getDefaultModel() returns
   * @param {Record<string, Function>} [options.api] - extra/overriding apiClient methods
   * @param {(detail: any) => Promise<boolean>} [options.promptForKey] - the api-keys key prompt; resolves true if a key was saved
   * @returns {{ plugin: InstanceType<typeof DocumentRulesPlugin>, requests: Record<string, any[]>, mergeViews: any[] }}
   */
  function setup({ modelList = models, defaultModel = { providerId: 'p2', modelId: 'm2' }, api = {}, promptForKey = async () => false } = {}) {
    const plugin = makePlugin(['reviewer']);
    plugin._editorDialogUi = makeDialogUi();
    plugin._editorDialogUi.open = true;
    plugin._updateDialogUi = makeUpdateDialogUi();
    plugin._proposeDialogUi = makeProposeDialogUi();
    plugin._resources = [human, machine];
    plugin._currentResource = machine;
    plugin._currentGroup = [human, machine];
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    const requests = { humanChange: [], updateFromGuide: [], overrides: [] };
    const mergeViews = [];
    plugin._createMergeView = (parent, original, modified) => {
      const view = { parent, original, modified, destroyed: false, destroy() { this.destroyed = true; } };
      mergeViews.push(view);
      return view;
    };
    const apiClient = {
      documentRulesHumanChange: async (body) => { requests.humanChange.push(body); return { ...humanChange }; },
      documentRulesUpdateFromGuide: async (body) => { requests.updateFromGuide.push(body); return { ...humanChange, proposed: '# M\n\nnew rules' }; },
      documentRulesOverrides: async (body) => { requests.overrides.push(body); return { id: 'ov-new', note: body.note, text: body.text, format: 'markdown', created_at: '', updated_at: '' }; },
      ...api,
    };
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient };
      if (name === 'inference-settings') return {
        getModels: () => modelList,
        getDefaultModel: () => defaultModel,
        getModelLabel: (providerId, modelId) => modelList.find(m => m.providerId === providerId && m.modelId === modelId)?.label ?? `${providerId}/${modelId}`,
      };
      if (name === 'logger') return { warn: () => {}, debug: () => {} };
      if (name === 'api-keys') return { withKeyPrompt: (action, blocker) => withKeyPrompt(action, promptForKey, blocker) };
      throw new Error(`unexpected dependency: ${name}`);
    };
    return { plugin, requests, mergeViews };
  }

  describe('updateFromGuideBtn visibility', () => {
    /**
     * @param {any} resource
     * @param {Array<any>} group
     * @param {boolean} [readOnly]
     * @returns {string}
     */
    function displayFor(resource, group, readOnly = false) {
      const { plugin } = setup();
      plugin._cmMdView = makeCmMdViewMock();
      plugin._cmView = { state: { doc: { length: 0 } }, dispatch: () => {}, scrollDOM: { scrollTop: 0 } };
      plugin._md = { render: (text) => text };
      plugin._currentResource = resource;
      plugin._currentGroup = group;
      plugin._currentOriginalText = 'text';
      plugin._documentReadOnly = readOnly;
      plugin._renderEditorDialog();
      return plugin._editorDialogUi.updateFromGuideBtn.style.display;
    }

    it('is hidden on the human layer', () => {
      assert.strictEqual(displayFor(human, [human, machine]), 'none');
    });

    it('is shown on the machine layer of a human/machine pair', () => {
      assert.strictEqual(displayFor(machine, [human, machine]), '');
    });

    it('is hidden for a single-layer resource', () => {
      assert.strictEqual(displayFor(schema, [schema]), 'none');
    });

    it('is hidden when the document is read-only', () => {
      assert.strictEqual(displayFor(machine, [human, machine], true), 'none');
    });
  });

  it('_openUpdateDialog requests the pair\'s guide change, shows it as a diff and preselects the default model', async () => {
    const { plugin, requests, mergeViews } = setup();
    await plugin._openUpdateDialog();
    const ui = plugin._updateDialogUi;
    assert.deepStrictEqual(requests.humanChange, [{ human_url: human.url, machine_url: machine.url }]);
    assert.strictEqual(mergeViews.length, 1);
    assert.strictEqual(mergeViews[0].parent, ui.humanDiff);
    assert.strictEqual(mergeViews[0].original, humanChange.old_human);
    assert.strictEqual(mergeViews[0].modified, humanChange.new_human);
    const options = [...ui.modelRow.modelSelect.querySelectorAll('sl-option')];
    assert.deepStrictEqual(options.map(o => o.textContent), models.map(m => m.label));
    assert.strictEqual(ui.modelRow.modelSelect.value, options[1].value);
    assert.strictEqual(ui.modelRow.style.display, '');
    assert.strictEqual(ui.notice.style.display, 'none');
    assert.strictEqual(ui.acceptBtn.disabled, true);
    assert.strictEqual(ui.proposedDiff.style.display, 'none');
    assert.strictEqual(ui.open, true);
  });

  it('_openUpdateDialog without models hides the picker and shows the no-model notice', async () => {
    const { plugin } = setup({ modelList: [], defaultModel: null });
    await plugin._openUpdateDialog();
    const ui = plugin._updateDialogUi;
    assert.strictEqual(ui.modelRow.style.display, 'none');
    assert.strictEqual(ui.notice.style.display, '');
    assert.strictEqual(ui.notice.textContent.trim(), 'No language model is available. Update the machine rules by hand, using the change shown above.');
  });

  it('_openUpdateDialog in align mode shows the align notice and diffs against an empty guide', async () => {
    const { plugin, mergeViews } = setup({ api: {
      documentRulesHumanChange: async () => ({ mode: 'align', old_human: null, new_human: '# G\n\nnew', machine: '# M', base_commit: null, unchanged: false }),
    } });
    await plugin._openUpdateDialog();
    const ui = plugin._updateDialogUi;
    assert.strictEqual(mergeViews[0].original, '');
    assert.strictEqual(ui.notice.style.display, '');
    assert.strictEqual(ui.notice.textContent.trim(), 'No sync base found: the model compares the whole guide section with the machine rules.');
  });

  it('_openUpdateDialog shows the unchanged notice when the backend reports the guide section unchanged', async () => {
    // The texts differ only in a way the section hash ignores
    const { plugin } = setup({ api: {
      documentRulesHumanChange: async () => ({ mode: 'delta', old_human: '# G\r\n', new_human: '# G\n', machine: '# M', base_commit: 'abc', unchanged: true }),
    } });
    await plugin._openUpdateDialog();
    assert.strictEqual(plugin._updateDialogUi.notice.textContent.trim(), 'The guide section has not changed since the last sync.');
  });

  it('_openUpdateDialog warns when the selected machine override was already updated from the guide, next to the other notices', async () => {
    const { plugin } = setup({ api: {
      documentRulesHumanChange: async () => ({ ...humanChange, unchanged: true }),
    } });
    plugin._currentOverrides = [{ id: 'ov1', note: 'Updated from guide with Provider 1/Model 1', text: '# M', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    await plugin._openUpdateDialog();
    const lines = [...plugin._updateDialogUi.notice.children].map(line => line.textContent);
    assert.deepStrictEqual(lines, [
      'The guide section has not changed since the last sync.',
      'The selected machine rules were already updated from the guide. Running the update again may apply the same change twice.',
    ]);
  });

  it('_openUpdateDialog shows no repeat warning for an override not created from the guide', async () => {
    const { plugin } = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: 'Hand edit', text: '# M', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    await plugin._openUpdateDialog();
    assert.strictEqual(plugin._updateDialogUi.notice.style.display, 'none');
  });

  it('_openUpdateDialog reads the repeat warning from the machine layer, not from another shown layer', async () => {
    const { plugin } = setup();
    plugin._currentResource = human;
    plugin._currentOverrides = [{ id: 'ov1', note: 'Updated from guide with Provider 1/Model 1', text: '# G', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    await plugin._openUpdateDialog();
    assert.strictEqual(plugin._updateDialogUi.notice.style.display, 'none');
  });

  it('_openUpdateDialog notifies and does not open the dialog when the request fails', async () => {
    const { plugin } = setup({ api: { documentRulesHumanChange: async () => { throw new Error('boom'); } } });
    await plugin._openUpdateDialog();
    assert.strictEqual(plugin._updateDialogUi.open, false);
    assert.strictEqual(notifyCalls.length, 1);
    assert.match(notifyCalls[0][0], /boom/);
  });

  it('_openUpdateDialog shows updateFromGuideBtn as loading and disabled while the guide change loads', async () => {
    let resolveRequest;
    const { plugin } = setup({ api: { documentRulesHumanChange: () => new Promise((resolve) => { resolveRequest = resolve; }) } });
    const btn = plugin._editorDialogUi.updateFromGuideBtn;
    const opening = plugin._openUpdateDialog();
    assert.strictEqual(btn.loading, true);
    assert.strictEqual(btn.disabled, true);
    resolveRequest({ ...humanChange });
    await opening;
    assert.strictEqual(btn.loading, false);
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(plugin._updateDialogUi.open, true);
  });

  it('_openUpdateDialog restores updateFromGuideBtn when the request fails', async () => {
    const { plugin } = setup({ api: { documentRulesHumanChange: async () => { throw new Error('boom'); } } });
    await plugin._openUpdateDialog();
    const btn = plugin._editorDialogUi.updateFromGuideBtn;
    assert.strictEqual(btn.loading, false);
    assert.strictEqual(btn.disabled, false);
  });

  it('_openUpdateDialog called twice while loading sends only one request', async () => {
    const resolvers = [];
    const { plugin } = setup({ api: { documentRulesHumanChange: () => new Promise((resolve) => { resolvers.push(resolve); }) } });
    const first = plugin._openUpdateDialog();
    const second = plugin._openUpdateDialog();
    for (const resolve of resolvers) resolve({ ...humanChange });
    await Promise.all([first, second]);
    assert.strictEqual(resolvers.length, 1);
    assert.strictEqual(plugin._updateDialogUi.open, true);
  });

  it('_openUpdateDialog does not open the sub-dialog when the editor dialog was closed meanwhile', async () => {
    let resolveRequest;
    const { plugin, mergeViews } = setup({ api: { documentRulesHumanChange: () => new Promise((resolve) => { resolveRequest = resolve; }) } });
    const opening = plugin._openUpdateDialog();
    plugin._editorDialogUi.open = false;
    resolveRequest({ ...humanChange });
    await opening;
    assert.strictEqual(plugin._updateDialogUi.open, false);
    assert.strictEqual(mergeViews.length, 0);
  });

  it('_openUpdateDialog does not open the sub-dialog when another rule category was opened meanwhile', async () => {
    let resolveRequest;
    const { plugin } = setup({ api: { documentRulesHumanChange: () => new Promise((resolve) => { resolveRequest = resolve; }) } });
    const opening = plugin._openUpdateDialog();
    plugin._currentResource = schema;
    plugin._currentGroup = [schema];
    resolveRequest({ ...humanChange });
    await opening;
    assert.strictEqual(plugin._updateDialogUi.open, false);
  });

  it('_openUpdateDialog does not open the sub-dialog when the document changed meanwhile', async () => {
    let resolveRequest;
    const { plugin } = setup({ api: { documentRulesHumanChange: () => new Promise((resolve) => { resolveRequest = resolve; }) } });
    plugin._refreshResources = () => {};
    plugin._editorDialogUi.hide = async () => { plugin._editorDialogUi.open = false; };
    const opening = plugin._openUpdateDialog();
    plugin.onXmlChange();
    resolveRequest({ ...humanChange });
    await opening;
    assert.strictEqual(plugin._updateDialogUi.open, false);
  });

  it('_onGenerate sends the document, the pair and the selected model, shows the proposal and enables accept', async () => {
    const { plugin, requests, mergeViews } = setup();
    await plugin._openUpdateDialog();
    const ui = plugin._updateDialogUi;
    const generating = plugin._onGenerate();
    assert.strictEqual(ui.modelRow.generateBtn.disabled, true);
    assert.strictEqual(ui.modelRow.generateBtn.loading, true);
    await generating;
    assert.deepStrictEqual(requests.updateFromGuide, [{ xml: 'stable123', human_url: human.url, machine_url: machine.url, provider_id: 'p2', model_id: 'm2' }]);
    assert.strictEqual(mergeViews.length, 2);
    assert.strictEqual(mergeViews[1].parent, ui.proposedDiff);
    assert.strictEqual(mergeViews[1].original, humanChange.machine);
    assert.strictEqual(mergeViews[1].modified, '# M\n\nnew rules');
    assert.strictEqual(plugin._proposedMachineText, '# M\n\nnew rules');
    assert.strictEqual(ui.proposedHeading.style.display, '');
    assert.strictEqual(ui.proposedDiff.style.display, '');
    assert.strictEqual(ui.acceptBtn.disabled, false);
    assert.strictEqual(ui.modelRow.generateBtn.disabled, false);
    assert.strictEqual(ui.modelRow.generateBtn.loading, false);
  });

  it('_onGenerate asks for a missing API key and shows the proposal of the retried request', async () => {
    const secretRequired = Object.assign(new Error('API key required'), {
      statusCode: 428,
      detail: { code: 'secret_required', service: 'openai', label: 'OpenAI' },
    });
    let calls = 0;
    const prompted = [];
    const { plugin, mergeViews } = setup({
      api: { documentRulesUpdateFromGuide: async () => { if (calls++ === 0) throw secretRequired; return { ...humanChange, proposed: '# M\n\nretried' }; } },
      promptForKey: async (detail) => { prompted.push(detail.service); return true; },
    });
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    assert.deepStrictEqual(prompted, ['openai']);
    assert.strictEqual(calls, 2);
    assert.strictEqual(notifyCalls.length, 0);
    assert.strictEqual(mergeViews[1].modified, '# M\n\nretried');
    assert.strictEqual(plugin._proposedMachineText, '# M\n\nretried');
    assert.strictEqual(plugin._updateDialogUi.acceptBtn.disabled, false);
  });

  it('_onGenerate on an error notifies, keeps the dialog open and accept disabled', async () => {
    const { plugin } = setup({ api: { documentRulesUpdateFromGuide: async () => { throw new Error('An API key is required'); } } });
    await plugin._openUpdateDialog();
    const ui = plugin._updateDialogUi;
    await plugin._onGenerate();
    assert.strictEqual(ui.open, true);
    assert.strictEqual(ui.acceptBtn.disabled, true);
    assert.strictEqual(ui.proposedDiff.style.display, 'none');
    assert.strictEqual(notifyCalls.length, 1);
    assert.match(notifyCalls[0][0], /An API key is required/);
    assert.strictEqual(notifyCalls[0][1], 'danger');
    assert.strictEqual(ui.modelRow.generateBtn.disabled, false);
    assert.strictEqual(ui.modelRow.generateBtn.loading, false);
  });

  it('_onAcceptProposal creates a machine override with the model note and the proposal, selects it and closes', async () => {
    const { plugin, requests } = setup();
    const selected = [];
    plugin._selectOverride = async (id) => { selected.push(id); plugin._currentSelectedId = id; };
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    // The note names the model the proposal was generated with, not a later choice
    const ui = plugin._updateDialogUi;
    ui.modelRow.modelSelect.value = ui.modelRow.modelSelect.querySelectorAll('sl-option')[0].value;
    await plugin._onAcceptProposal();
    assert.deepStrictEqual(requests.overrides, [{ kind: machine.kind, fragment_url: machine.url, note: 'Updated from guide with Provider 2/Model 2', text: '# M\n\nnew rules' }]);
    assert.deepStrictEqual(plugin._currentOverrides.map(o => o.id), ['ov-new']);
    assert.deepStrictEqual(selected, ['ov-new']);
    assert.strictEqual(ui.open, false);
  });

  it('_onAcceptProposal opens the machine layer first when another layer is shown', async () => {
    const { plugin } = setup();
    const selected = [];
    const opened = [];
    plugin._selectOverride = async (id) => { selected.push(id); plugin._currentSelectedId = id; };
    plugin._openResourceEditor = async (resource) => {
      opened.push(resource);
      plugin._currentResource = resource;
      // The re-query already lists the new override
      plugin._currentOverrides = [{ id: 'ov-new', note: '', text: '', format: 'markdown', created_at: '', updated_at: '' }];
    };
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    plugin._currentResource = human;
    await plugin._onAcceptProposal();
    assert.deepStrictEqual(opened, [machine]);
    assert.deepStrictEqual(plugin._currentOverrides.map(o => o.id), ['ov-new']);
    assert.deepStrictEqual(selected, ['ov-new']);
  });

  it('_onAcceptProposal on an error notifies and keeps the dialog open', async () => {
    const { plugin } = setup({ api: { documentRulesOverrides: async () => { throw new Error('nope'); } } });
    let selectedCalls = 0;
    plugin._selectOverride = async () => { selectedCalls++; };
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    await plugin._onAcceptProposal();
    assert.strictEqual(plugin._updateDialogUi.open, true);
    assert.strictEqual(selectedCalls, 0);
    assert.match(notifyCalls[0][0], /nope/);
  });

  it('_resetUpdateDialog (on close) destroys the merge views and drops the proposal', async () => {
    const { plugin, mergeViews } = setup();
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    plugin._resetUpdateDialog();
    assert.deepStrictEqual(mergeViews.map(v => v.destroyed), [true, true]);
    assert.strictEqual(plugin._proposedMachineText, null);
    assert.strictEqual(plugin._updateDialogUi.acceptBtn.disabled, true);
  });

  it('_onGenerate drops a response that arrives after the dialog was closed', async () => {
    let resolveRequest;
    const { plugin, mergeViews } = setup({ api: { documentRulesUpdateFromGuide: () => new Promise((resolve) => { resolveRequest = resolve; }) } });
    await plugin._openUpdateDialog();
    const generating = plugin._onGenerate();
    plugin._resetUpdateDialog();
    resolveRequest({ ...humanChange, proposed: '# M\n\nlate' });
    await generating;
    assert.strictEqual(mergeViews.length, 1);
    assert.strictEqual(plugin._proposedMachineText, null);
    assert.strictEqual(plugin._updateDialogUi.acceptBtn.disabled, true);
  });

  it('_onGenerate drops an error that arrives after the dialog was reopened, leaving the new session\'s buttons alone', async () => {
    const rejects = [];
    const { plugin } = setup({ api: { documentRulesUpdateFromGuide: () => new Promise((resolve, reject) => { rejects.push(reject); }) } });
    await plugin._openUpdateDialog();
    const stale = plugin._onGenerate();
    plugin._resetUpdateDialog();
    await plugin._openUpdateDialog();
    plugin._onGenerate();
    rejects[0](new Error('stale failure'));
    await stale;
    const { generateBtn } = plugin._updateDialogUi.modelRow;
    assert.strictEqual(notifyCalls.length, 0);
    assert.strictEqual(generateBtn.disabled, true);
    assert.strictEqual(generateBtn.loading, true);
  });

  it('_onAcceptProposal called twice concurrently creates only one override, with accept and generate disabled meanwhile', async () => {
    let resolveCreate;
    const created = [];
    const { plugin } = setup({ api: { documentRulesOverrides: (body) => { created.push(body); return new Promise((resolve) => { resolveCreate = resolve; }); } } });
    plugin._selectOverride = async (id) => { plugin._currentSelectedId = id; };
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    const ui = plugin._updateDialogUi;
    const first = plugin._onAcceptProposal();
    const second = plugin._onAcceptProposal();
    assert.strictEqual(ui.acceptBtn.disabled, true);
    assert.strictEqual(ui.acceptBtn.loading, true);
    assert.strictEqual(ui.modelRow.generateBtn.disabled, true);
    resolveCreate({ id: 'ov-new', note: '', text: '', format: 'markdown', created_at: '', updated_at: '' });
    await Promise.all([first, second]);
    assert.strictEqual(created.length, 1);
  });

  it('_onAcceptProposal re-enables accept and generate when creating the override fails', async () => {
    const { plugin } = setup({ api: { documentRulesOverrides: async () => { throw new Error('nope'); } } });
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    await plugin._onAcceptProposal();
    const ui = plugin._updateDialogUi;
    assert.strictEqual(ui.acceptBtn.disabled, false);
    assert.strictEqual(ui.acceptBtn.loading, false);
    assert.strictEqual(ui.modelRow.generateBtn.disabled, false);
  });

  it('_onAcceptProposal drops the proposal and closes once the override exists, even if the layer switch fails', async () => {
    const { plugin, requests } = setup();
    let selectedCalls = 0;
    plugin._selectOverride = async () => { selectedCalls++; };
    // A failed switch leaves the human layer open (and has notified already)
    plugin._openResourceEditor = async () => {};
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    plugin._currentResource = human;
    await plugin._onAcceptProposal();
    const ui = plugin._updateDialogUi;
    assert.strictEqual(plugin._proposedMachineText, null);
    assert.strictEqual(plugin._proposedModel, null);
    assert.strictEqual(ui.acceptBtn.disabled, true);
    assert.strictEqual(ui.open, false);
    assert.strictEqual(selectedCalls, 0);
    await plugin._onAcceptProposal();
    assert.strictEqual(requests.overrides.length, 1);
  });

  it('_onAcceptProposal shows the new override in the row and closes when selecting it fails', async () => {
    const { plugin } = setup({ api: { documentRulesSelection: async () => { throw new Error('selection failed'); } } });
    plugin._cmMdView = makeCmMdViewMock();
    plugin._md = { render: (text) => text };
    await plugin._openUpdateDialog();
    await plugin._onGenerate();
    await plugin._onAcceptProposal();
    const labels = [...plugin._editorDialogUi.overrideRow.children].map(b => b.textContent);
    assert.deepStrictEqual(labels, ['Original', 'Override 1']);
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.strictEqual(plugin._updateDialogUi.open, false);
    assert.match(notifyCalls[0][0], /selection failed/);
  });

  it('onXmlChange hides the sub-dialog', () => {
    const { plugin } = setup();
    plugin._refreshResources = () => {};
    plugin._editorDialogUi.hide = async () => { plugin._editorDialogUi.open = false; };
    plugin._updateDialogUi.open = true;
    plugin.onXmlChange();
    assert.strictEqual(plugin._updateDialogUi.open, false);
  });

  it('_createMergeView builds a read-only CodeMirror view showing the modified text', () => {
    const plugin = makePlugin();
    const parent = document.createElement('div');
    const view = plugin._createMergeView(parent, 'old line', 'new line');
    try {
      assert.strictEqual(view.state.doc.toString(), 'new line');
      assert.strictEqual(getOriginalDoc(view.state).toString(), 'old line');
      assert.strictEqual(view.state.readOnly, true);
      assert.ok(parent.contains(view.dom));
    } finally {
      view.destroy();
    }
  });
});

describe('DocumentRulesPlugin "Propose upstream" (paired)', () => {
  const human = { kind: 'interpretation-ref', url: 'https://example.com/g.md#primary', key: 'k', label: 'Primary sources', format: 'markdown', layer: 'human', group: 'interpretation-ref:primary' };
  const machine = { kind: 'interpretation-ref', url: 'https://example.com/rules.md', key: 'k2', label: 'Primary sources', format: 'markdown', layer: 'machine', group: 'interpretation-ref:primary' };
  const schema = { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml', layer: null, group: null };

  const HUMAN_ONLY_NOTICE = 'The machine rules will be marked as outdated until they are updated from the guide.';
  const MACHINE_NOTICE = 'The sync marker is updated: the machine rules are marked as in sync with the guide.';
  const MACHINE_OUTDATED_NOTICE = 'The machine rules were derived from a guide text that differs from the guide upstream; they will be marked as outdated.';
  const UNSAVED_NOTICE = 'Unsaved changes in the editor are not included. Save them first.';

  /**
   * @param {any} body
   * @returns {any}
   */
  function proposal(body) {
    const files = [];
    if (body.include_human) files.push({ path: 'docs/guidelines.md', before: 'g old', after: 'g new' });
    if (body.include_machine) files.push({ path: 'docs/guidelines-llm.md', before: 'm old', after: 'm new' });
    const includes = body.include_human && body.include_machine ? 'guide section and machine rules' : body.include_human ? 'guide section' : 'machine rules';
    return {
      files, patch: `# patch ${files.map(f => f.path).join(',')}\n`, filename: 'primary-sources-rules.patch', branch: 'main', upstream_changed: [], in_sync: body.include_machine,
      can_open_pull_request: true, pull_request_title: 'Annotation rules update: Primary sources', pull_request_body: `Includes: ${includes}.`,
    };
  }

  /**
   * @param {object} [options]
   * @param {Record<string, Function>} [options.api]
   * @param {(detail: any) => Promise<boolean>} [options.promptForKey] - the api-keys key prompt; resolves true if a key was saved
   * @returns {{ plugin: InstanceType<typeof DocumentRulesPlugin>, apiClient: Record<string, Function>, requests: any[], mergeViews: any[] }}
   */
  function setup({ api = {}, promptForKey = async () => false } = {}) {
    const plugin = makePlugin(['reviewer']);
    plugin._editorDialogUi = makeDialogUi();
    plugin._editorDialogUi.open = true;
    plugin._updateDialogUi = { open: false };
    plugin._proposeDialogUi = makeProposeDialogUi();
    plugin._resources = [human, machine];
    plugin._currentResource = human;
    plugin._currentGroup = [human, machine];
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._selections = [];
    const requests = [];
    const mergeViews = [];
    plugin._createMergeView = (parent, original, modified) => {
      const view = { parent, original, modified, destroyed: false, destroy() { this.destroyed = true; } };
      mergeViews.push(view);
      return view;
    };
    const apiClient = {
      documentRulesProposePatch: async (body) => { requests.push(body); return proposal(body); },
      ...api,
    };
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient };
      if (name === 'logger') return { warn: () => {}, debug: () => {} };
      if (name === 'api-keys') return { withKeyPrompt: (action, blocker) => withKeyPrompt(action, promptForKey, blocker) };
      throw new Error(`unexpected dependency: ${name}`);
    };
    return { plugin, apiClient, requests, mergeViews };
  }

  /**
   * @param {HTMLElement} el
   * @returns {string[]}
   */
  function noticeLines(el) {
    return [...el.children].map(c => c.textContent);
  }

  /**
   * @param {HTMLElement} files
   * @returns {string[]}
   */
  function pathHeadings(files) {
    return [...files.querySelectorAll('[data-role="path"]')].map(h => h.textContent);
  }

  beforeEach(() => { notifyCalls.length = 0; });

  describe('proposeUpstreamBtn', () => {
    /**
     * @param {any} resource
     * @param {Array<any>} group
     * @param {{ selected?: boolean, readOnly?: boolean }} [options]
     * @returns {string}
     */
    function displayFor(resource, group, { selected = false, readOnly = false } = {}) {
      const { plugin } = setup();
      plugin._cmMdView = makeCmMdViewMock();
      plugin._cmView = { state: { doc: { length: 0 } }, dispatch: () => {}, scrollDOM: { scrollTop: 0 } };
      plugin._md = { render: (text) => text };
      plugin._currentResource = resource;
      plugin._currentGroup = group;
      plugin._currentOriginalText = 'text';
      plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: resource.format, created_at: '', updated_at: '' }];
      plugin._currentSelectedId = selected ? 'ov1' : null;
      plugin._documentReadOnly = readOnly;
      plugin._renderEditorDialog();
      return plugin._editorDialogUi.proposeUpstreamBtn.style.display;
    }

    it('is shown in a two-layer group even without a selected override', () => {
      assert.strictEqual(displayFor(human, [human, machine]), '');
      assert.strictEqual(displayFor(machine, [human, machine]), '');
    });

    it('is hidden in a two-layer group when the document is read-only', () => {
      assert.strictEqual(displayFor(human, [human, machine], { selected: true, readOnly: true }), 'none');
    });

    it('keeps the old rule for a single-layer resource', () => {
      assert.strictEqual(displayFor(schema, [schema]), 'none');
      assert.strictEqual(displayFor(schema, [schema], { selected: true }), '');
    });

    it('opens the sub-dialog in a two-layer group and uses the old flow otherwise', async () => {
      const { plugin } = setup();
      const calls = [];
      plugin._openProposeDialog = async () => { calls.push('dialog'); };
      plugin._onProposeUpstream = async () => { calls.push('old'); };
      await plugin._onProposeUpstreamClick();
      plugin._currentResource = schema;
      plugin._currentGroup = [schema];
      await plugin._onProposeUpstreamClick();
      assert.deepStrictEqual(calls, ['dialog', 'old']);
    });
  });

  describe('_openProposeDialog preselection', () => {
    it('checks each layer with a selected override', async () => {
      const { plugin, requests } = setup();
      plugin._selections = [{ kind: 'interpretation-ref', url: machine.url, selected: true }, { kind: 'interpretation-ref', url: human.url, selected: false }];
      await plugin._openProposeDialog();
      const ui = plugin._proposeDialogUi;
      assert.strictEqual(ui.includeHuman.checked, false);
      assert.strictEqual(ui.includeMachine.checked, true);
      assert.deepStrictEqual(requests, [{ human_url: human.url, machine_url: machine.url, include_human: false, include_machine: true, label: 'Primary sources' }]);
      assert.strictEqual(ui.open, true);
    });

    it('uses the shown layer\'s current selection over the cached selections', async () => {
      const { plugin } = setup();
      plugin._cmMdView = makeCmMdViewMock('x');
      plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
      plugin._currentSelectedId = 'ov1';
      plugin._selections = [{ kind: 'interpretation-ref', url: machine.url, selected: true }];
      await plugin._openProposeDialog();
      const ui = plugin._proposeDialogUi;
      assert.strictEqual(ui.includeHuman.checked, true);
      assert.strictEqual(ui.includeMachine.checked, true);
    });

    it('falls back to the shown layer when neither layer has a selected override', async () => {
      const { plugin } = setup();
      plugin._currentResource = machine;
      await plugin._openProposeDialog();
      const ui = plugin._proposeDialogUi;
      assert.strictEqual(ui.includeHuman.checked, false);
      assert.strictEqual(ui.includeMachine.checked, true);
    });
  });

  it('_refreshProposal renders one merge view per file under its path heading and enables download', async () => {
    const { plugin, mergeViews } = setup();
    const ui = plugin._proposeDialogUi;
    ui.includeHuman.checked = true;
    ui.includeMachine.checked = true;
    await plugin._refreshProposal();
    assert.deepStrictEqual(pathHeadings(ui.files), ['docs/guidelines.md', 'docs/guidelines-llm.md']);
    assert.strictEqual(mergeViews.length, 2);
    assert.deepStrictEqual(mergeViews.map(v => [v.original, v.modified]), [['g old', 'g new'], ['m old', 'm new']]);
    assert.ok(ui.files.contains(mergeViews[0].parent));
    assert.ok(ui.files.contains(mergeViews[1].parent));
    assert.strictEqual(ui.downloadBtn.disabled, false);
  });

  it('toggling a checkbox requests again with the new flags and replaces the merge views', async () => {
    const { plugin, requests, mergeViews } = setup();
    plugin._installProposeDialogListeners();
    await plugin._openProposeDialog();
    const ui = plugin._proposeDialogUi;
    assert.strictEqual(ui.includeHuman.checked, true);
    ui.includeMachine.checked = true;
    ui.includeMachine.dispatchEvent(new dom.window.Event('sl-change'));
    await plugin._proposalPromise;
    assert.deepStrictEqual(requests.map(r => [r.include_human, r.include_machine]), [[true, false], [true, true]]);
    assert.strictEqual(mergeViews[0].destroyed, true);
    assert.deepStrictEqual(pathHeadings(ui.files), ['docs/guidelines.md', 'docs/guidelines-llm.md']);
  });

  describe('notices', () => {
    /**
     * @param {boolean} includeHuman
     * @param {boolean} includeMachine
     * @returns {Promise<string[]>}
     */
    async function noticesFor(includeHuman, includeMachine) {
      const { plugin } = setup();
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = includeHuman;
      ui.includeMachine.checked = includeMachine;
      await plugin._refreshProposal();
      return ui.notice.style.display === 'none' ? [] : noticeLines(ui.notice);
    }

    it('warns that the machine rules become outdated when only the guide is included', async () => {
      assert.deepStrictEqual(await noticesFor(true, false), [HUMAN_ONLY_NOTICE]);
    });

    it('says the sync marker is updated when the machine rules are included', async () => {
      assert.deepStrictEqual(await noticesFor(false, true), [MACHINE_NOTICE]);
      assert.deepStrictEqual(await noticesFor(true, true), [MACHINE_NOTICE]);
    });

    it('says the machine rules become outdated when they are included but not in sync', async () => {
      const { plugin } = setup({ api: { documentRulesProposePatch: async (body) => ({ ...proposal(body), in_sync: false }) } });
      const ui = plugin._proposeDialogUi;
      ui.includeMachine.checked = true;
      await plugin._refreshProposal();
      assert.deepStrictEqual(noticeLines(ui.notice), [MACHINE_OUTDATED_NOTICE]);
    });

    it('warns per file whose section changed upstream', async () => {
      const { plugin } = setup({ api: { documentRulesProposePatch: async (body) => ({ ...proposal(body), upstream_changed: ['docs/guidelines.md', 'docs/guidelines-llm.md'] }) } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      ui.includeMachine.checked = true;
      await plugin._refreshProposal();
      assert.deepStrictEqual(noticeLines(ui.notice), [
        'The section in docs/guidelines.md changed upstream since your version; the patch replaces those changes.',
        'The section in docs/guidelines-llm.md changed upstream since your version; the patch replaces those changes.',
        MACHINE_NOTICE,
      ]);
    });

    it('warns that unsaved editor changes are not included', async () => {
      const { plugin } = setup();
      plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'saved', format: 'markdown', created_at: '', updated_at: '' }];
      plugin._currentSelectedId = 'ov1';
      plugin._cmMdView = makeCmMdViewMock('edited');
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      assert.deepStrictEqual(noticeLines(ui.notice), [UNSAVED_NOTICE, HUMAN_ONLY_NOTICE]);
      plugin._cmMdView = makeCmMdViewMock('saved');
      await plugin._refreshProposal();
      assert.deepStrictEqual(noticeLines(ui.notice), [HUMAN_ONLY_NOTICE]);
    });
  });

  it('clears the shown diffs while a new request is pending', async () => {
    const { plugin, apiClient, mergeViews } = setup();
    const ui = plugin._proposeDialogUi;
    ui.includeHuman.checked = true;
    await plugin._refreshProposal();
    let resolveRequest;
    apiClient.documentRulesProposePatch = (body) => new Promise((resolve) => { resolveRequest = () => resolve(proposal(body)); });
    const pending = plugin._refreshProposal();
    assert.strictEqual(mergeViews[0].destroyed, true);
    assert.strictEqual(ui.files.children.length, 0);
    assert.strictEqual(ui.downloadBtn.disabled, true);
    assert.strictEqual(plugin._proposal, null);
    resolveRequest();
    await pending;
    assert.deepStrictEqual(pathHeadings(ui.files), ['docs/guidelines.md']);
  });

  it('a failing refresh from the checkbox handler is logged and shown, not rejected', async () => {
    const { plugin } = setup();
    const warnings = [];
    plugin.getDependency = (name) => {
      if (name === 'logger') return { warn: (msg) => warnings.push(msg), debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    plugin._refreshProposal = async () => { throw new Error('render failed'); };
    plugin._installProposeDialogListeners();
    plugin._proposeDialogUi.includeHuman.dispatchEvent(new dom.window.Event('sl-change'));
    await plugin._proposalPromise;
    assert.deepStrictEqual(noticeLines(plugin._proposeDialogUi.notice), ['render failed']);
    assert.strictEqual(warnings.length, 1);
    await plugin._openProposeDialog();
    assert.deepStrictEqual(noticeLines(plugin._proposeDialogUi.notice), ['render failed']);
  });

  it('drops a stale response', async () => {
    const pending = [];
    const { plugin, requests } = setup({ api: {
      documentRulesProposePatch: (body) => { requests.push(body); return new Promise((resolve) => { pending.push(() => resolve(proposal(body))); }); },
    } });
    const ui = plugin._proposeDialogUi;
    ui.includeHuman.checked = true;
    const first = plugin._refreshProposal();
    ui.includeMachine.checked = true;
    const second = plugin._refreshProposal();
    pending[1]();
    await second;
    pending[0]();
    await first;
    assert.deepStrictEqual(pathHeadings(ui.files), ['docs/guidelines.md', 'docs/guidelines-llm.md']);
    assert.strictEqual(plugin._proposal.patch, '# patch docs/guidelines.md,docs/guidelines-llm.md\n');
  });

  it('shows a 422 message inline, clears the files and disables download', async () => {
    const { plugin, apiClient, mergeViews } = setup();
    const ui = plugin._proposeDialogUi;
    ui.includeHuman.checked = true;
    await plugin._refreshProposal();
    assert.strictEqual(ui.downloadBtn.disabled, false);
    apiClient.documentRulesProposePatch = async () => {
      throw Object.assign(new Error('Select at least one of the guide section and the machine rules.'), { statusCode: 422 });
    };
    ui.includeHuman.checked = false;
    await plugin._refreshProposal();
    assert.deepStrictEqual(noticeLines(ui.notice), ['Select at least one of the guide section and the machine rules.']);
    assert.strictEqual(ui.notice.style.display, '');
    assert.strictEqual(ui.files.children.length, 0);
    assert.strictEqual(mergeViews[0].destroyed, true);
    assert.strictEqual(ui.downloadBtn.disabled, true);
    assert.strictEqual(plugin._proposal, null);
    assert.strictEqual(notifyCalls.length, 0);
  });

  it('_onDownloadPatch downloads the patch as a text/x-diff Blob under the proposed file name', async () => {
    const { plugin } = setup();
    const ui = plugin._proposeDialogUi;
    ui.includeHuman.checked = true;
    await plugin._refreshProposal();

    const blobs = [];
    const revoked = [];
    const clicks = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = dom.window.HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:patch'; };
    URL.revokeObjectURL = (url) => { revoked.push(url); };
    dom.window.HTMLAnchorElement.prototype.click = function () { clicks.push({ href: this.href, download: this.download }); };
    try {
      plugin._onDownloadPatch();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      dom.window.HTMLAnchorElement.prototype.click = originalClick;
    }
    assert.strictEqual(blobs.length, 1);
    assert.strictEqual(blobs[0].type, 'text/x-diff');
    assert.strictEqual(await blobs[0].text(), '# patch docs/guidelines.md\n');
    assert.deepStrictEqual(clicks, [{ href: 'blob:patch', download: 'primary-sources-rules.patch' }]);
    assert.deepStrictEqual(revoked, ['blob:patch']);
  });

  describe('pull request', () => {
    const created = { url: 'https://github.com/o/r/pull/7', number: 7, branch: 'pdf-tei-editor/primary-sources-20261028-120000', fork: null };

    it('hides the controls when the guide is not on GitHub', async () => {
      const { plugin } = setup({ api: { documentRulesProposePatch: async (body) => ({ ...proposal(body), can_open_pull_request: false }) } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      assert.strictEqual(ui.prSection.style.display, 'none');
      assert.strictEqual(ui.createPrBtn.style.display, 'none');
      assert.strictEqual(ui.downloadBtn.disabled, false);
    });

    it('shows the controls with the default texts and enables the button when the guide is on GitHub', async () => {
      const { plugin } = setup();
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      assert.strictEqual(ui.prSection.style.display, '');
      assert.strictEqual(ui.createPrBtn.style.display, '');
      assert.strictEqual(ui.createPrBtn.disabled, false);
      assert.strictEqual(ui.prSection.prTitle.value, 'Annotation rules update: Primary sources');
      assert.strictEqual(ui.prSection.prBody.value, 'Includes: guide section.');
    });

    it('disables the button while a request is pending and after an error', async () => {
      const { plugin, apiClient } = setup();
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      let resolveRequest;
      apiClient.documentRulesProposePatch = (body) => new Promise((resolve) => { resolveRequest = () => resolve(proposal(body)); });
      const pending = plugin._refreshProposal();
      assert.strictEqual(ui.createPrBtn.disabled, true);
      resolveRequest();
      await pending;
      assert.strictEqual(ui.createPrBtn.disabled, false);
      apiClient.documentRulesProposePatch = async () => { throw new Error('nothing to change'); };
      await plugin._refreshProposal();
      assert.strictEqual(ui.createPrBtn.disabled, true);
    });

    it('keeps an edited title on a checkbox toggle and replaces an untouched description', async () => {
      const { plugin } = setup();
      const ui = plugin._proposeDialogUi;
      plugin._installProposeDialogListeners();
      await plugin._openProposeDialog();
      assert.strictEqual(ui.prSection.prBody.value, 'Includes: guide section.');
      ui.prSection.prTitle.value = 'My title';
      ui.prSection.prTitle.dispatchEvent(new dom.window.Event('sl-input'));
      ui.includeMachine.checked = true;
      ui.includeMachine.dispatchEvent(new dom.window.Event('sl-change'));
      await plugin._proposalPromise;
      assert.strictEqual(ui.prSection.prTitle.value, 'My title');
      assert.strictEqual(ui.prSection.prBody.value, 'Includes: guide section and machine rules.');
    });

    it('keeps an edited description on a checkbox toggle and replaces an untouched title', async () => {
      const { plugin, apiClient } = setup();
      const ui = plugin._proposeDialogUi;
      plugin._installProposeDialogListeners();
      await plugin._openProposeDialog();
      ui.prSection.prBody.value = 'My description';
      ui.prSection.prBody.dispatchEvent(new dom.window.Event('sl-input'));
      apiClient.documentRulesProposePatch = async (body) => ({ ...proposal(body), pull_request_title: 'New default' });
      ui.includeMachine.checked = true;
      ui.includeMachine.dispatchEvent(new dom.window.Event('sl-change'));
      await plugin._proposalPromise;
      assert.strictEqual(ui.prSection.prTitle.value, 'New default');
      assert.strictEqual(ui.prSection.prBody.value, 'My description');
    });

    it('takes the defaults again after the dialog was closed and reopened', async () => {
      const { plugin } = setup();
      const ui = plugin._proposeDialogUi;
      plugin._installProposeDialogListeners();
      await plugin._openProposeDialog();
      ui.prSection.prBody.value = 'My description';
      ui.prSection.prBody.dispatchEvent(new dom.window.Event('sl-input'));
      await plugin._openProposeDialog();
      assert.strictEqual(ui.prSection.prBody.value, 'Includes: guide section.');
    });

    it('sends the edited title and body with the proposal flags through withKeyPrompt', async () => {
      const secretRequired = Object.assign(new Error('API key required'), {
        statusCode: 428,
        detail: { code: 'secret_required', service: 'github', label: 'GitHub' },
      });
      const prRequests = [];
      const prompted = [];
      const { plugin } = setup({
        api: { documentRulesProposePullRequest: async (body) => { prRequests.push(body); if (prRequests.length === 1) throw secretRequired; return created; } },
        promptForKey: async (detail) => { prompted.push(detail.service); return true; },
      });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      ui.includeMachine.checked = true;
      await plugin._refreshProposal();
      ui.prSection.prTitle.value = 'Edited title';
      ui.prSection.prBody.value = 'Edited body';
      await plugin._onCreatePullRequest();
      assert.deepStrictEqual(prompted, ['github']);
      assert.strictEqual(prRequests.length, 2);
      assert.deepStrictEqual(prRequests[1], {
        human_url: human.url, machine_url: machine.url, include_human: true, include_machine: true, label: human.label,
        title: 'Edited title', body: 'Edited body',
      });
    });

    it('shows the created pull request with a link and keeps the button disabled', async () => {
      const prRequests = [];
      const { plugin } = setup({ api: { documentRulesProposePullRequest: async (body) => { prRequests.push(body); return created; } } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      await plugin._onCreatePullRequest();
      const result = ui.prSection.prResult;
      assert.strictEqual(result.textContent, 'Pull request #7 created. Open on GitHub');
      const link = result.querySelector('a');
      assert.strictEqual(link.textContent, 'Open on GitHub');
      assert.strictEqual(link.getAttribute('href'), 'https://github.com/o/r/pull/7');
      assert.strictEqual(link.getAttribute('target'), '_blank');
      assert.strictEqual(link.getAttribute('rel'), 'noopener');
      assert.strictEqual(ui.createPrBtn.disabled, true);
      assert.strictEqual(prRequests.length, 1);
    });

    it('names the fork a pull request was opened from', async () => {
      const { plugin } = setup({ api: { documentRulesProposePullRequest: async () => ({ ...created, number: 8, fork: 'me/r' }) } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      await plugin._onCreatePullRequest();
      assert.strictEqual(ui.prSection.prResult.textContent, 'Pull request #8 created. Open on GitHub. It was opened from your fork me/r.');
    });

    it('shows an error message and re-enables the button', async () => {
      const { plugin } = setup({ api: { documentRulesProposePullRequest: async () => { throw Object.assign(new Error('The pull request needs a title.'), { statusCode: 422 }); } } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      await plugin._onCreatePullRequest();
      assert.strictEqual(ui.prSection.prResult.textContent, 'The pull request needs a title.');
      assert.strictEqual(ui.createPrBtn.disabled, false);
    });

    it('disables the button and clears the previous result while the request is pending', async () => {
      let resolveRequest;
      const { plugin } = setup({ api: { documentRulesProposePullRequest: () => new Promise((resolve) => { resolveRequest = () => resolve(created); }) } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      ui.prSection.prResult.textContent = 'previous error';
      const pending = plugin._onCreatePullRequest();
      assert.strictEqual(ui.createPrBtn.disabled, true);
      assert.strictEqual(ui.prSection.prResult.textContent, '');
      resolveRequest();
      await pending;
    });

    it('_resetProposeDialog hides the controls and clears the result', async () => {
      const { plugin } = setup({ api: { documentRulesProposePullRequest: async () => created } });
      const ui = plugin._proposeDialogUi;
      ui.includeHuman.checked = true;
      await plugin._refreshProposal();
      await plugin._onCreatePullRequest();
      plugin._resetProposeDialog();
      assert.strictEqual(ui.prSection.style.display, 'none');
      assert.strictEqual(ui.createPrBtn.style.display, 'none');
      assert.strictEqual(ui.createPrBtn.disabled, true);
      assert.strictEqual(ui.prSection.prResult.textContent, '');
    });
  });

  it('_resetProposeDialog (on close) destroys the merge views and drops a pending response', async () => {
    let resolveRequest;
    const { plugin, apiClient, mergeViews } = setup();
    const ui = plugin._proposeDialogUi;
    ui.includeHuman.checked = true;
    await plugin._refreshProposal();
    apiClient.documentRulesProposePatch = (body) => new Promise((resolve) => { resolveRequest = () => resolve(proposal(body)); });
    const pending = plugin._refreshProposal();
    plugin._resetProposeDialog();
    assert.strictEqual(mergeViews[0].destroyed, true);
    assert.strictEqual(ui.files.children.length, 0);
    assert.strictEqual(ui.downloadBtn.disabled, true);
    resolveRequest();
    await pending;
    assert.strictEqual(mergeViews.length, 1);
    assert.strictEqual(plugin._proposal, null);
  });

  it('onXmlChange hides the sub-dialog', () => {
    const { plugin } = setup();
    plugin._refreshResources = () => {};
    plugin._editorDialogUi.hide = async () => { plugin._editorDialogUi.open = false; };
    plugin._proposeDialogUi.open = true;
    plugin.onXmlChange();
    assert.strictEqual(plugin._proposeDialogUi.open, false);
  });
});

#!/usr/bin/env node

/**
 * Templates and stylesheets of backend plugin frontend extensions: registration from the
 * extension bundle and the template methods of FrontendExtensionPlugin.
 *
 * @testCovers app/src/modules/ui-system.js
 * @testCovers app/src/modules/frontend-extension-registry.js
 * @testCovers app/src/modules/frontend-extension-plugin.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Document = dom.window.Document;
global.Node = dom.window.Node;

let updateUiCalls = 0;
mock.module('../../../app/src/ui.js', {
  defaultExport: {},
  namedExports: { updateUi: () => { updateUiCalls++; } }
});

const uiSystem = await import('../../../app/src/modules/ui-system.js');
const {
  registerFrontendExtension,
  registerFrontendExtensionTemplates,
  registerFrontendExtensionStyles,
  clearExtensions
} = await import('../../../app/src/modules/frontend-extension-registry.js');
const { FrontendExtensionPlugin } = await import('../../../app/src/modules/frontend-extension-plugin.js');

describe('ui-system addTemplateHtml', () => {
  it('stores a loaded template synchronously', () => {
    uiSystem.addTemplateHtml('test:add', '  <div name="x">${label}</div>\n');
    assert.strictEqual(uiSystem.getRegisteredTemplateHtml('test:add'), '<div name="x">${label}</div>');
    const el = uiSystem.createSingleFromTemplate('test:add', null, { label: 'Hi' });
    assert.strictEqual(el.textContent, 'Hi');
  });

  it('throws for unknown templates', () => {
    assert.throws(() => uiSystem.getRegisteredTemplateHtml('test:missing'), /not registered/);
  });
});

describe('registerFrontendExtensionTemplates / registerFrontendExtensionStyles', () => {
  it('are exposed globally for the bundle', () => {
    assert.strictEqual(window.registerFrontendExtensionTemplates, registerFrontendExtensionTemplates);
    assert.strictEqual(window.registerFrontendExtensionStyles, registerFrontendExtensionStyles);
  });

  it('prefixes template ids with the plugin id', () => {
    registerFrontendExtensionTemplates('my-plugin', { dialog: '<sl-dialog></sl-dialog>' });
    assert.ok(uiSystem.getRegisteredTemplates().includes('my-plugin:dialog'));
  });

  it('adds one style element per plugin and replaces it on reload', () => {
    registerFrontendExtensionStyles('my-plugin', 'a { color: red }');
    registerFrontendExtensionStyles('my-plugin', 'a { color: blue }');
    const styles = document.head.querySelectorAll('style[data-plugin="my-plugin"]');
    assert.strictEqual(styles.length, 1);
    assert.strictEqual(styles[0].textContent, 'a { color: blue }');
  });
});

describe('FrontendExtensionPlugin template methods', () => {
  beforeEach(() => {
    clearExtensions();
    updateUiCalls = 0;
  });

  function makeExtension() {
    class TemplateExtension extends FrontendExtensionPlugin {}
    registerFrontendExtension(TemplateExtension, 'ref-plugin');
    return new TemplateExtension(/** @type {any} */ ({}), { name: 'template-extension' });
  }

  it('gets the backend plugin id from the bundle registration', () => {
    const ext = makeExtension();
    assert.strictEqual(ext.backendPluginId, 'ref-plugin');
    assert.strictEqual(ext.templateId('dialog'), 'ref-plugin:dialog');
  });

  it('creates elements from the prefixed template', () => {
    registerFrontendExtensionTemplates('ref-plugin', { dialog: '<sl-dialog name="refPluginDialog" label="${title}"></sl-dialog>' });
    const ext = makeExtension();
    assert.strictEqual(ext.getTemplateHtml('dialog'), '<sl-dialog name="refPluginDialog" label="${title}"></sl-dialog>');

    const detached = ext.createSingleFromTemplate('dialog', null, { title: 'T' });
    assert.strictEqual(detached.getAttribute('label'), 'T');
    assert.strictEqual(updateUiCalls, 0);

    const nodes = ext.createFromTemplate('dialog', document.body, { title: 'U' });
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(document.body.lastElementChild, nodes[0]);
    assert.strictEqual(updateUiCalls, 1);
  });

  it('names the missing template', () => {
    const ext = makeExtension();
    assert.throws(() => ext.createSingleFromTemplate('nope'), /ref-plugin:nope/);
  });

  it('fails clearly outside the bundle', () => {
    class Unbundled extends FrontendExtensionPlugin {}
    const ext = new Unbundled(/** @type {any} */ ({}));
    assert.strictEqual(ext.backendPluginId, undefined);
    assert.throws(() => ext.templateId('dialog'), /no backend plugin id/);
  });
});

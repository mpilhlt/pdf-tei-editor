#!/usr/bin/env node

/**
 * Regression test for issue #646: spurious "This document has no owner" toast on page reload.
 *
 * On reload, `state.xml` (and a stale `state.fileData`) are restored from sessionStorage, but the
 * file data ID lookup index used by `getFileDataById()` is only built once the file list has been
 * fetched from the server. A state update arriving before that (e.g. the user change after login)
 * made AccessControlPlugin compute `owner = null` in owner-based mode, show the "no owner" toast
 * and cache the result for that document, so the real owner was never picked up.
 *
 * @testCovers app/src/plugins/access-control.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.customElements = dom.window.customElements;
global.CustomEvent = dom.window.CustomEvent;
global.Event = dom.window.Event;
global.Node = dom.window.Node;

// notify()'s real implementation uses Shoelace's SlAlert, which leaves dangling promises under jsdom
const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: {
    notify: (...args) => { notifyCalls.push(args); }
  }
});

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { default: AccessControlPlugin } = await import('../../../app/src/plugins/access-control.js');
const { createIdLookupIndex } = await import('../../../app/src/modules/file-data-utils.js');

const XML_ID = 'xml-stable-id';
const user = { username: 'alice', fullname: 'Alice', roles: ['annotator', 'reviewer'] };

/**
 * @param {string|null} createdBy
 */
function fileData(createdBy) {
  return [{
    doc_id: 'doc1',
    collections: ['c1'],
    source: { id: 'pdf-stable-id', label: 'Doc' },
    artifacts: [{ id: XML_ID, label: 'Doc', created_by: createdBy }]
  }];
}

/**
 * Creates the plugin in owner-based mode with stubbed dependencies and a mutable state object.
 */
async function makePlugin() {
  const app = new Application(new PluginManager(), new StateManager());
  const plugin = new AccessControlPlugin(app.getPluginContext());
  const state = { xml: XML_ID, user, editorReadOnly: false, fileData: fileData('bob') }
  Object.defineProperty(plugin, 'state', { get: () => state, configurable: true });
  const scheduled = [];
  plugin.scheduleStateChange = async (changes) => { scheduled.push(changes); return state; };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const deps = {
    logger,
    client: { apiClient: { filesAccessControlMode: async () => ({ mode: 'owner-based', default_visibility: 'collection', default_editability: 'owner' }) } },
    authentication: { getUser: () => user },
    xmleditor: { setReadOnlyContext() {} }
  };
  plugin.getDependency = (name) => deps[name];
  await plugin.start();
  return { plugin, state, scheduled };
}

beforeEach(() => {
  notifyCalls.length = 0;
  createIdLookupIndex([]);
});

describe('AccessControlPlugin on page reload (owner-based mode)', () => {
  it('does not report a missing owner before the file data index is loaded', async () => {
    const { plugin, scheduled } = await makePlugin();

    // state.xml and stale state.fileData restored, lookup index still empty
    await plugin.onStateUpdate(['user']);

    assert.strictEqual(notifyCalls.length, 0, `unexpected toast: ${JSON.stringify(notifyCalls)}`);
    assert.deepStrictEqual(scheduled, [], 'must not make the editor read-only while ownership is unknown');

    // file list loaded from the server: real owner becomes known
    createIdLookupIndex(fileData('bob'));
    await plugin.onStateUpdate(['fileData']);

    assert.strictEqual(notifyCalls.length, 1);
    assert.match(notifyCalls[0][0], /owned by bob/);
    assert.strictEqual(plugin.getDocumentPermissions().owner, 'bob');
    assert.deepStrictEqual(scheduled, [{ editorReadOnly: true }]);
  });

  it('shows no toast for the own document once the index is loaded', async () => {
    const { plugin, scheduled } = await makePlugin();
    await plugin.onStateUpdate(['user']);
    createIdLookupIndex(fileData('alice'));
    await plugin.onStateUpdate(['fileData']);

    assert.strictEqual(notifyCalls.length, 0);
    assert.deepStrictEqual(scheduled, []);
  });

  it('still reports a document that really has no owner', async () => {
    const { plugin } = await makePlugin();
    createIdLookupIndex(fileData(null));
    await plugin.onStateUpdate(['xml']);

    assert.strictEqual(notifyCalls.length, 1);
    assert.match(notifyCalls[0][0], /has no owner/);
  });
});

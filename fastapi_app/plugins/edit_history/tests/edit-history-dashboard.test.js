/**
 * Unit tests for the edit history dashboard box.
 *
 * @testCovers fastapi_app/plugins/edit_history/extensions/edit-history-dashboard.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

class FakeFrontendExtensionPlugin {
  constructor() {
    this._deps = {};
  }
  getDependency(name) { return this._deps[name]; }
}
global.FrontendExtensionPlugin = FakeFrontendExtensionPlugin;

const { default: EditHistoryDashboardExtension } = await import('../extensions/edit-history-dashboard.js');

/**
 * @param {object} response - Response of the /recent route
 */
function buildExtension(response) {
  const ext = new EditHistoryDashboardExtension({});
  /** @type {any[]} */
  const rendered = [];
  /** @type {any[]} */
  const executed = [];
  /** @type {any[]} */
  const opened = [];
  /** @type {string[]} */
  const calls = [];
  ext.callPluginApi = async () => response;
  ext._deps.dashboard = {
    renderDocumentList: groups => { rendered.push(groups); return { groups }; },
    close: async () => { calls.push('close'); },
    openDocument: async (...args) => { opened.push(args); }
  };
  ext._deps['backend-plugins'] = { execute: async (...args) => { calls.push('execute'); executed.push(args); } };
  return { ext, rendered, executed, opened, calls };
}

const edit = {
  stable_id: 's1', pdf_stable_id: 'p1', title: 'Document A', label: 'Gold', variant: 'v1',
  collections: ['c1'], description: 'Corrected references', who: 'Alice', change_status: 'draft',
  when: '2026-10-19T08:00:00'
};

describe('EditHistoryDashboardExtension', () => {
  it('contributes nothing without edits', async () => {
    const { ext } = buildExtension({ edits: [] });
    assert.deepStrictEqual(await ext['dashboard.contributions'](), []);
  });

  it('shows the edit with its author and opens the document', async () => {
    const { ext, rendered, opened } = buildExtension({ edits: [edit] });
    const [box] = await ext.getContributions();
    assert.strictEqual(box.id, 'edit-history');

    const [item] = rendered[0][0].items;
    assert.deepStrictEqual([item.title, item.link, item.detail, item.status], ['Document A', 'Corrected references', 'Alice', 'draft']);

    await item.onClick();
    assert.deepStrictEqual(opened, [['s1', 'p1', 'c1']]);
  });

  it('"See all" closes the dashboard and opens the edit history of all projects', async () => {
    const { ext, executed, calls } = buildExtension({ edits: [edit] });
    const [box] = await ext.getContributions();
    assert.strictEqual(box.action.label, 'See all');

    await box.action.onClick();
    assert.deepStrictEqual(calls, ['close', 'execute']);
    assert.deepStrictEqual(executed, [['edit-history', 'show_all', {}]]);
  });
});

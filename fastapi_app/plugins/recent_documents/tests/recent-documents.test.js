/**
 * Unit tests for the recent documents frontend extension.
 *
 * @testCovers fastapi_app/plugins/recent_documents/extensions/recent-documents.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

class FakeFrontendExtensionPlugin {
  constructor(context, config = {}) {
    this.context = context;
    this._config = config;
    this._deps = {};
  }
  getDependency(name) { return this._deps[name]; }
}
global.FrontendExtensionPlugin = FakeFrontendExtensionPlugin;

const { default: RecentDocumentsExtension, rowsForLines } = await import('../extensions/recent-documents.js');

/**
 * @param {object} response - Response of the /recent route
 */
function buildExtension(response) {
  const ext = new RecentDocumentsExtension({});
  const opened = [];
  /** @type {any[]} */
  const rendered = [];
  ext.callPluginApi = async () => response;
  ext._deps.dashboard = {
    renderDocumentList: groups => { rendered.push(groups); return { groups }; },
    openDocument: (...args) => opened.push(args)
  };
  return { ext, opened, rendered };
}

describe('RecentDocumentsExtension', () => {
  it('contributes nothing when the user has no recent documents', async () => {
    const { ext } = buildExtension({ projects: [] });
    assert.deepStrictEqual(await ext['dashboard.contributions'](), []);
  });

  it('contributes one box with a group per project and opens documents on click', async () => {
    const { ext, opened, rendered } = buildExtension({
      projects: [{
        id: 'p1', name: 'Project One',
        documents: [{ stable_id: 's1', pdf_stable_id: 'p1pdf', doc_id: 'd1', title: 'Doc', label: null, variant: 'v1', status: 'draft', collections: ['c1'], edited_at: '2026-10-19T08:00:00+00:00' }]
      }]
    });

    const [box] = await ext.getContributions();

    assert.strictEqual(box.id, 'recent-documents');
    assert.strictEqual(box.cols, 1);
    assert.strictEqual(box.rows, 1);
    const [groups] = rendered;
    assert.strictEqual(groups[0].heading, 'Project One');
    assert.strictEqual(groups[0].items[0].title, 'Doc');
    assert.strictEqual(groups[0].items[0].link, 'v1', 'falls back to the variant without a TEI label');
    groups[0].items[0].onClick();
    assert.deepStrictEqual(opened, [['s1', 'p1pdf', 'c1']]);
  });

  it('asks for more rows for longer lists, up to four', () => {
    assert.strictEqual(rowsForLines(4), 1);
    assert.strictEqual(rowsForLines(9), 3);
    assert.strictEqual(rowsForLines(40), 4);
  });
});

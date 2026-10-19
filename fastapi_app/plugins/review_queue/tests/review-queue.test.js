/**
 * Unit tests for the review queue frontend extension.
 *
 * @testCovers fastapi_app/plugins/review_queue/extensions/review-queue.js
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

const { default: ReviewQueueExtension } = await import('../extensions/review-queue.js');

/**
 * @param {object} response - Response of the /documents route
 */
function buildExtension(response) {
  const ext = new ReviewQueueExtension({});
  /** @type {any[]} */
  const rendered = [];
  ext.callPluginApi = async () => response;
  ext._deps.dashboard = {
    renderDocumentList: groups => { rendered.push(groups); return { groups }; },
    openDocument: () => {}
  };
  return { ext, rendered };
}

const doc = (id, status = 'in-review') => ({
  stable_id: id, pdf_stable_id: null, doc_id: id, title: id, label: `${id} TEI`, variant: null, status,
  collections: ['c1'], project: 'Project One', updated_at: '2026-10-19T08:00:00'
});

describe('ReviewQueueExtension', () => {
  it('contributes nothing when no document waits for review', async () => {
    const { ext } = buildExtension({ statuses: ['in-review'], documents: [] });
    assert.deepStrictEqual(await ext['dashboard.contributions'](), []);
  });

  it('shows the count in the title and the status only if several statuses are configured', async () => {
    const single = buildExtension({ statuses: ['in-review'], documents: [doc('a'), doc('b')] });
    const [box] = await single.ext.getContributions();
    assert.strictEqual(box.title, 'Waiting for review (2)');
    assert.strictEqual(single.rendered[0][0].items[0].status, null);
    assert.strictEqual(single.rendered[0][0].items[0].link, 'a TEI');

    const several = buildExtension({ statuses: ['in-review', 'checked'], documents: [doc('a', 'checked')] });
    await several.ext.getContributions();
    assert.strictEqual(several.rendered[0][0].items[0].status, 'checked');
  });
});

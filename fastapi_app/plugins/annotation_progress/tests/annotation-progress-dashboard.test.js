/**
 * Unit tests for the annotation progress dashboard box.
 *
 * @testCovers fastapi_app/plugins/annotation_progress/extensions/annotation-progress-dashboard.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

class FakeFrontendExtensionPlugin {
  constructor(context, config = {}) {
    this.context = context;
    this._config = config;
  }
}
global.FrontendExtensionPlugin = FakeFrontendExtensionPlugin;

const {
  default: AnnotationProgressDashboardExtension,
  rowsForProjects,
  projectVariants,
  projectPercentage
} = await import('../extensions/annotation-progress-dashboard.js');

const project = {
  id: 'p1',
  name: 'Project One',
  batches: [
    { id: 'c1', name: 'Batch one', total: 10, variants: [{ variant: 'v2', done: 5 }, { variant: 'v1', done: 10 }] },
    { id: 'c2', name: 'Batch two', total: 10, variants: [{ variant: 'v3', done: 0 }] }
  ]
};

describe('annotation progress dashboard helpers', () => {
  it('orders the variants of a project once', () => {
    assert.deepStrictEqual(projectVariants(project), ['v1', 'v2', 'v3']);
  });

  it('computes the share over all collection and variant combinations', () => {
    assert.strictEqual(projectPercentage(project), 50);
    assert.strictEqual(projectPercentage({ ...project, batches: [] }), 0);
  });

  it('asks for one row per five lines, at most four', () => {
    assert.strictEqual(rowsForProjects([project]), 1);
    const many = { ...project, batches: Array.from({ length: 30 }, () => project.batches[0]) };
    assert.strictEqual(rowsForProjects([many]), 4);
  });
});

describe('AnnotationProgressDashboardExtension', () => {
  it('contributes nothing when no collection has documents', async () => {
    const ext = new AnnotationProgressDashboardExtension({});
    ext.callPluginApi = async () => ({ threshold: 'approved', projects: [] });
    assert.deepStrictEqual(await ext['dashboard.contributions'](), []);
  });
});

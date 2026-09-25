/**
 * Unit tests for the annotation-review frontend extension.
 *
 * @testCovers fastapi_app/plugins/annotation_review/extensions/annotation-review.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Stub browser-only base class before the dynamic import below.
class FakeFrontendExtensionPlugin {
  constructor(context, config = {}) {
    this.context = context;
    this._config = config;
    this._deps = {};
  }
  getDependency(name) {
    if (!(name in this._deps)) throw new Error(`no stub dependency registered for "${name}"`);
    return this._deps[name];
  }
  async callPluginApi() {
    throw new Error('callPluginApi must be stubbed per-test');
  }
}
global.FrontendExtensionPlugin = FakeFrontendExtensionPlugin;

const { default: AnnotationReviewExtension } = await import('../extensions/annotation-review.js');

/**
 * Build an extension instance with stubbed dependencies.
 * @param {{xmlDoc?: object|null, editorContent?: string, defaultModel?: object|null, callPluginApiImpl?: Function}} opts
 */
function buildExtension(opts = {}) {
  const ext = new AnnotationReviewExtension({});
  const notifyCalls = [];
  ext._deps = {
    xmleditor: {
      getXmlTree: () => (opts.xmlDoc === undefined ? {} : opts.xmlDoc),
      getEditorContent: () => opts.editorContent ?? '<TEI/>',
    },
    'sl-utils': {
      notify: (...args) => notifyCalls.push(args),
    },
    'tei-utils': {
      getEditorialDeclGuides: opts.getEditorialDeclGuides ?? (() => []),
    },
    'inference-settings': {
      getDefaultModel: () => opts.defaultModel ?? null,
    },
  };
  ext.callPluginApi = opts.callPluginApiImpl ?? (async () => { throw new Error('unexpected call'); });
  return { ext, notifyCalls };
}

describe('hasReviewableRules', () => {
  it('returns true when at least one category has a machine-subtype ref', () => {
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
    });
    assert.strictEqual(ext.hasReviewableRules({}), true);
  });

  it('returns false when no category has a machine-subtype ref', () => {
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'human' }] }],
    });
    assert.strictEqual(ext.hasReviewableRules({}), false);
  });

  it('returns false for an empty guides list', () => {
    const { ext } = buildExtension({ getEditorialDeclGuides: () => [] });
    assert.strictEqual(ext.hasReviewableRules({}), false);
  });
});

describe('review', () => {
  it('notifies and returns null when no document is open', async () => {
    const { ext, notifyCalls } = buildExtension({ xmlDoc: null });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0][1], 'warning');
  });

  it('notifies and returns null when the document has no reviewable rules', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'human' }] }],
    });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
  });

  it('notifies and returns null when no default model is configured', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: null,
    });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
  });

  it('calls the review endpoint with resolved default provider/model and returns findings', async () => {
    const calls = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'kisski', modelId: 'gemma-3' },
      editorContent: '<TEI>content</TEI>',
      callPluginApiImpl: async (endpoint, method, params) => {
        calls.push({ endpoint, method, params });
        return { findings: [{ id: 0, old: 'a', new: 'b', rationale: 'r' }] };
      },
    });
    const result = await ext.review();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].endpoint, '/api/plugins/annotation-review/review');
    assert.strictEqual(calls[0].method, 'POST');
    assert.deepStrictEqual(calls[0].params, {
      xml: '<TEI>content</TEI>',
      provider_id: 'kisski',
      model_id: 'gemma-3',
    });
    assert.deepStrictEqual(result, [{ id: 0, old: 'a', new: 'b', rationale: 'r' }]);
  });

  it('uses an explicit override instead of the default model', async () => {
    const calls = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'kisski', modelId: 'gemma-3' },
      callPluginApiImpl: async (endpoint, method, params) => {
        calls.push(params);
        return { findings: [] };
      },
    });
    await ext.review({ providerId: 'other', modelId: 'other-model' });
    assert.strictEqual(calls[0].provider_id, 'other');
    assert.strictEqual(calls[0].model_id, 'other-model');
  });

  it('notifies and returns null when the API call fails', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'kisski', modelId: 'gemma-3' },
      callPluginApiImpl: async () => { throw new Error('boom'); },
    });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0][1], 'danger');
  });
});

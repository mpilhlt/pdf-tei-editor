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
global.document = { createElement: () => ({ addEventListener(t, fn) { this._click = fn; }, style: {} }) };

const { default: AnnotationReviewExtension, locateFinding, buildModifiedText, findingsToDiagnostics } =
  await import('../extensions/annotation-review.js');

/**
 * Build an extension instance with stubbed dependencies.
 * @param {{xmlDoc?: object|null, editorContent?: string, defaultModel?: object|null, callPluginApiImpl?: Function}} opts
 */
function buildExtension(opts = {}) {
  const ext = new AnnotationReviewExtension({});
  const notifyCalls = [];
  const confirmCalls = [], lintCalls = [], updateListeners = [], mergeViews = [], menuAdds = [], progressCalls = [], progressOpts = {}, handlers = {};
  ext._deps = {
    tools: { addMenuItems: (items, category) => menuAdds.push({ items, category }) },
    progress: {
      show: (id, o) => { progressOpts.show = o; progressCalls.push(['show', o.label]); },
      setValue: (id, v) => progressCalls.push(['value', v]),
      setLabel: (id, l) => progressCalls.push(['label', l]),
      hide: () => progressCalls.push(['hide']),
    },
    'lint-utils': {
      replacesDiagnostics: opts.replacesDiagnostics ?? (() => false),
      applyMergedDiagnostics: (view, source, own, options) => lintCalls.push({ view, source, own, options }),
    },
    xmleditor: {
      getView: () => ({ state: { doc: { toString: () => opts.docText ?? '' } } }),
      addUpdateListener: (fn) => { updateListeners.push(fn); },
      showMergeView: async (text) => { if (opts.showMergeViewImpl) return opts.showMergeViewImpl(text); mergeViews.push(text); },
      on: (event, fn) => { handlers[event] = fn; },
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
      getModelLabel: (providerId, modelId) => `${providerId} label/${modelId} label`,
    },
    dialog: {
      confirm: async (message, title) => { confirmCalls.push({ message, title }); return opts.confirmAnswer ?? true; },
    },
  };
  if (opts.state) ext.state = opts.state;
  const impl = opts.callPluginApiImpl ?? (async () => { throw new Error('unexpected call'); });
  ext.callPluginApi = async (endpoint, ...rest) => {
    if (endpoint.endsWith('/plan')) {
      if (opts.planImpl) return opts.planImpl();
      // the plan request only counts chunks; existing impls answer review requests
      return { chunk_count: opts.chunkCount ?? 1 };
    }
    return impl(endpoint, ...rest);
  };
  return { ext, notifyCalls, confirmCalls, lintCalls, updateListeners, mergeViews, menuAdds, progressCalls, progressOpts, handlers };
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
      chunk_index: 0,
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

describe('locateFinding', () => {
  const finding = { id: 0, old: '<b>x</b>', new: '<i>x</i>', rationale: 'r' };

  it('returns the range of the single occurrence', () => {
    assert.deepStrictEqual(locateFinding(finding, 'aa<b>x</b>bb'), { from: 2, to: 10 });
  });

  it('returns null when old is absent', () => {
    assert.strictEqual(locateFinding(finding, 'nothing here'), null);
  });

  it('returns null when old occurs more than once', () => {
    assert.strictEqual(locateFinding(finding, '<b>x</b><b>x</b>'), null);
  });
});

describe('buildModifiedText', () => {
  it('replaces exactly the given range with the new text', () => {
    const finding = { id: 0, old: 'BAD', new: 'GOOD', rationale: 'r' };
    assert.strictEqual(buildModifiedText('a BAD b', 2, 5, finding), 'a GOOD b');
  });

  it('returns null when the text at the range no longer equals old', () => {
    const finding = { id: 0, old: 'BAD', new: 'GOOD', rationale: 'r' };
    assert.strictEqual(buildModifiedText('a XYZ b', 2, 5, finding), null);
  });
});

describe('findingsToDiagnostics', () => {
  it('builds one info diagnostic per locatable finding, with a Propose fix action', () => {
    const findings = [
      { id: 0, old: 'AAA', new: 'a', rationale: 'first' },
      { id: 1, old: 'MISSING', new: 'm', rationale: 'dropped' },
    ];
    const proposed = [];
    const result = findingsToDiagnostics(findings, 'x AAA y', (finding, from, to) => proposed.push([finding.id, from, to]));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].severity, 'info');
    assert.strictEqual(result[0].message, 'first');
    assert.deepStrictEqual([result[0].from, result[0].to], [2, 5]);
    assert.strictEqual(result[0].actions[0].name, 'Propose fix');
    result[0].actions[0].apply({}, 2, 5);
    assert.deepStrictEqual(proposed, [[0, 2, 5]]);
  });
});

describe('showFindings / clearFindings', () => {
  const finding = { id: 0, old: 'AAA', new: 'a', rationale: 'why' };

  it('merges diagnostics for locatable findings under the annotation-review source', () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([finding]);
    assert.strictEqual(lintCalls.length, 1);
    assert.strictEqual(lintCalls[0].source, 'annotation-review');
    assert.strictEqual(lintCalls[0].own.length, 1);
    assert.strictEqual(lintCalls[0].own[0].message, 'why');
  });

  it('clearFindings merges an empty own list', () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([finding]);
    ext.clearFindings();
    assert.deepStrictEqual(lintCalls.at(-1).own, []);
  });
});

describe('re-rendering after diagnostics are replaced', () => {
  it('re-merges the stored findings when another source replaced the diagnostics', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({
      docText: 'x AAA y',
      replacesDiagnostics: () => true,
    });
    await ext.start();
    ext.showFindings([{ id: 0, old: 'AAA', new: 'a', rationale: 'why' }]);
    const before = lintCalls.length;
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, before + 1);
  });

  it('does not re-merge while it is itself applying diagnostics', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({ docText: 'x AAA y', replacesDiagnostics: () => true });
    await ext.start();
    // simulate the listener firing synchronously inside our own dispatch
    ext._rendering = true;
    ext._findings = [{ id: 0, old: 'AAA', new: 'a', rationale: 'why' }];
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, 0);
  });
});

describe('Propose fix', () => {
  it('opens the merge view with only that finding applied', async () => {
    const { ext, mergeViews } = buildExtension({ docText: 'x AAA y' });
    await ext._proposeFix({ id: 0, old: 'AAA', new: 'a', rationale: 'r' }, 2, 5);
    assert.deepStrictEqual(mergeViews, ['x a y']);
  });

  it('notifies instead when the text no longer matches', async () => {
    const { ext, mergeViews, notifyCalls } = buildExtension({ docText: 'x ZZZ y' });
    await ext._proposeFix({ id: 0, old: 'AAA', new: 'a', rationale: 'r' }, 2, 5);
    assert.strictEqual(mergeViews.length, 0);
    assert.strictEqual(notifyCalls[0][1], 'warning');
  });
});

describe('onXmlChange', () => {
  it('drops stale findings', async () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }]);
    await ext.onXmlChange('newdoc');
    assert.deepStrictEqual(lintCalls.at(-1).own, []);
  });
});

describe('menu item', () => {
  it('adds a disabled "Review Annotations" item to the annotation category', async () => {
    const { ext, menuAdds } = buildExtension({ xmlDoc: null });
    await ext.start();
    assert.strictEqual(menuAdds.length, 1);
    assert.strictEqual(menuAdds[0].category, 'annotation');
    assert.strictEqual(menuAdds[0].items[0].textContent, 'Review Annotations');
    assert.strictEqual(menuAdds[0].items[0].disabled, true);
  });

  it('enables the item once the document has reviewable rules', async () => {
    const { ext, menuAdds, handlers } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
    });
    await ext.start();
    handlers.editorReady();
    assert.strictEqual(menuAdds[0].items[0].disabled, false);
  });

  it('keeps the item disabled when there is no machine rule ref', async () => {
    const { ext, menuAdds, handlers } = buildExtension({ getEditorialDeclGuides: () => [] });
    await ext.start();
    handlers.editorReady();
    assert.strictEqual(menuAdds[0].items[0].disabled, true);
  });
});

describe('runReview', () => {
  const rules = [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }];

  it('shows a progress widget, displays findings and reports the count', async () => {
    const { ext, progressCalls, notifyCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'x AAA y',
      callPluginApiImpl: async () => ({ findings: [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }] }),
    });
    await ext.runReview();
    assert.deepStrictEqual(progressCalls.filter(c => c[0] === 'show' || c[0] === 'hide').map(c => c[0]), ['show', 'hide']);
    assert.strictEqual(lintCalls.at(-1).own.length, 1);
    assert.match(notifyCalls.at(-1)[0], /1 suggestion/);
  });

  it('reports when nothing was found', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      callPluginApiImpl: async () => ({ findings: [] }),
    });
    await ext.runReview();
    assert.strictEqual(notifyCalls.at(-1)[1], 'success');
  });

  it('hides the progress widget and shows nothing when review() fails', async () => {
    const { ext, progressCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      callPluginApiImpl: async () => { throw new Error('boom'); },
    });
    await ext.runReview();
    assert.deepStrictEqual(progressCalls.filter(c => c[0] === 'show' || c[0] === 'hide').map(c => c[0]), ['show', 'hide']);
    assert.strictEqual(lintCalls.length, 0);
  });
});

describe('lint panel handling', () => {
  it('showFindings asks to open the lint panel', () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }]);
    assert.deepStrictEqual(lintCalls[0].options, { openPanel: true });
  });

  it('the listener-driven re-render does not open the lint panel', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({ docText: 'x AAA y', replacesDiagnostics: () => true });
    await ext.start();
    ext.showFindings([{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }]);
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, 2);
    assert.deepStrictEqual(lintCalls[1].options, { openPanel: false });
  });
});

describe('hardening', () => {
  it('_proposeFix notifies when showMergeView throws', async () => {
    const { ext, notifyCalls } = buildExtension({
      docText: 'x AAA y',
      showMergeViewImpl: async () => { throw new Error('nope'); },
    });
    await ext._proposeFix({ id: 0, old: 'AAA', new: 'a', rationale: 'r' }, 2, 5);
    assert.strictEqual(notifyCalls.at(-1)[1], 'danger');
    assert.match(notifyCalls.at(-1)[0], /nope/);
  });

  it('clearFindings without findings dispatches nothing', async () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    await ext.onXmlChange('doc');
    ext.clearFindings();
    assert.strictEqual(lintCalls.length, 0);
  });

  it('runReview discards findings when the document changed meanwhile', async () => {
    const state = { xml: 'a' };
    const { ext, lintCalls, notifyCalls } = buildExtension({
      state,
      getEditorialDeclGuides: () => [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'x AAA y',
      callPluginApiImpl: async () => {
        state.xml = 'b';
        return { findings: [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }] };
      },
    });
    await ext.runReview();
    assert.strictEqual(lintCalls.length, 0);
    assert.strictEqual(notifyCalls.length, 0);
  });

  it('does not subscribe to editorXmlNotWellFormed', async () => {
    const { ext, handlers } = buildExtension();
    await ext.start();
    assert.strictEqual('editorXmlNotWellFormed' in handlers, false);
  });
});

describe('runReview confirmation', () => {
  const rules = [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }];

  it('asks for confirmation naming the provider/model and puts it in the progress label', async () => {
    const { ext, confirmCalls, progressCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'kisski', modelId: 'gemma' },
      callPluginApiImpl: async () => ({ findings: [] }),
    });
    await ext.runReview();
    assert.strictEqual(
      confirmCalls[0].message,
      'Review the annotations in the current document using kisski label/gemma label?'
    );
    assert.strictEqual(progressCalls[0][1], 'Reviewing annotations using kisski label/gemma label…');
  });

  it('does nothing when the user cancels', async () => {
    let apiCalled = false;
    const { ext, progressCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'kisski', modelId: 'gemma' },
      confirmAnswer: false,
      callPluginApiImpl: async () => { apiCalled = true; return { findings: [] }; },
    });
    await ext.runReview();
    assert.strictEqual(apiCalled, false);
    assert.deepStrictEqual(progressCalls, []);
    assert.strictEqual(lintCalls.length, 0);
  });

  it('escapes HTML in the label shown in the dialog', async () => {
    const { ext, confirmCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'a<b>', modelId: 'm&n' },
      callPluginApiImpl: async () => ({ findings: [] }),
    });
    await ext.runReview();
    assert.ok(confirmCalls[0].message.includes('a&lt;b&gt; label/m&amp;n label'));
  });

  it('skips the dialog and lets review() notify when no model is configured', async () => {
    const { ext, confirmCalls, notifyCalls } = buildExtension({ getEditorialDeclGuides: () => rules });
    await ext.runReview();
    assert.strictEqual(confirmCalls.length, 0);
    assert.match(notifyCalls[0][0], /No default model/);
  });

  it('uses an explicit override for the label and the request', async () => {
    const calls = [];
    const { ext, confirmCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'kisski', modelId: 'gemma' },
      callPluginApiImpl: async (e, m, params) => { calls.push(params); return { findings: [] }; },
    });
    await ext.runReview({ providerId: 'other', modelId: 'big' });
    assert.ok(confirmCalls[0].message.includes('other label/big label'));
    assert.strictEqual(calls[0].provider_id, 'other');
  });
});

describe('chunked review', () => {
  const rules = [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }];
  const finding = (old) => ({ id: 0, old, new: 'n', rationale: 'r' });

  it('review() requests every chunk, merges the findings and renumbers ids', async () => {
    const indexes = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      chunkCount: 3,
      callPluginApiImpl: async (e, m, params) => {
        indexes.push(params.chunk_index);
        return { findings: [finding(`A${params.chunk_index}`)], chunk_count: 3 };
      },
    });
    const result = await ext.review();
    assert.deepStrictEqual(indexes, [0, 1, 2]);
    assert.deepStrictEqual(result.map(f => [f.id, f.old]), [[0, 'A0'], [1, 'A1'], [2, 'A2']]);
  });

  it('review() reports progress after each chunk with the findings so far', async () => {
    const seen = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      chunkCount: 2,
      callPluginApiImpl: async (e, m, params) => ({ findings: [finding(`A${params.chunk_index}`)], chunk_count: 2 }),
    });
    await ext.review(undefined, { onProgress: (done, total, found) => seen.push([done, total, found.length]) });
    assert.deepStrictEqual(seen, [[1, 2, 1], [2, 2, 2]]);
  });

  it('review() stops before the next chunk when cancelled and returns what it has', async () => {
    let cancelled = false;
    const indexes = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      chunkCount: 5,
      callPluginApiImpl: async (e, m, params) => {
        indexes.push(params.chunk_index);
        return { findings: [finding('A')], chunk_count: 5 };
      },
    });
    const result = await ext.review(undefined, { isCancelled: () => cancelled, onProgress: () => { cancelled = true; } });
    assert.deepStrictEqual(indexes, [0]);
    assert.strictEqual(result.length, 1);
  });

  it('review() names the failing part and returns null when a later chunk fails', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      chunkCount: 3,
      callPluginApiImpl: async (e, m, params) => {
        if (params.chunk_index === 1) throw new Error('boom');
        return { findings: [], chunk_count: 3 };
      },
    });
    assert.strictEqual(await ext.review(), null);
    assert.match(notifyCalls.at(-1)[0], /part 2 of 3: boom/);
  });

  it('runReview shows findings as chunks complete and keeps them when a later chunk fails', async () => {
    const { ext, lintCalls, progressCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'A0 A1 A2',
      chunkCount: 3,
      callPluginApiImpl: async (e, m, params) => {
        if (params.chunk_index === 1) throw new Error('boom');
        return { findings: [finding('A0')], chunk_count: 3 };
      },
    });
    await ext.runReview();
    assert.strictEqual(lintCalls.at(-1).own.length, 1);
    assert.strictEqual(progressCalls.at(-1)[0], 'hide');
  });

  it('runReview updates the progress value and label per chunk', async () => {
    const { ext, progressCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      chunkCount: 2,
      callPluginApiImpl: async () => ({ findings: [], chunk_count: 2 }),
    });
    await ext.runReview();
    assert.match(progressCalls.filter(c => c[0] === 'label').map(c => c[1]).join('|'), /part 1 of 2.*part 2 of 2/);
    assert.deepStrictEqual(progressCalls.filter(c => c[0] === 'value').map(c => c[1]), [0, 50, 100]);
  });

  it('cancelling via the widget stops the review and reports the partial result', async () => {
    const indexes = [];
    let ctx;
    ctx = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'A0 A1 A2',
      chunkCount: 3,
      callPluginApiImpl: async (e, m, params) => {
        indexes.push(params.chunk_index);
        if (params.chunk_index === 0) ctx.progressOpts.show.onCancel();
        return { findings: [finding(`A${params.chunk_index}`)], chunk_count: 3 };
      },
    });
    await ctx.ext.runReview();
    assert.deepStrictEqual(indexes, [0]);
    assert.match(ctx.notifyCalls.at(-1)[0], /cancelled after 1 of 3 parts; 1 suggestion/);
    assert.strictEqual(ctx.progressCalls.at(-1)[0], 'hide');
  });

  it('opens the lint panel only for the first batch of findings', async () => {
    const { ext, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'A0 A1',
      chunkCount: 2,
      callPluginApiImpl: async (e, m, params) => ({ findings: [finding(`A${params.chunk_index}`)], chunk_count: 2 }),
    });
    await ext.runReview();
    assert.deepStrictEqual(lintCalls.map(c => c.options.openPanel), [true, false]);
  });
});

describe('pruning findings after edits', () => {
  it('drops findings whose old text was edited away and re-renders', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({ docText: 'x BBB y' });
    await ext.start();
    ext._pruneDelayMs = 1;
    ext._findings = [
      { id: 0, old: 'AAA', new: 'a', rationale: 'gone' },
      { id: 1, old: 'BBB', new: 'b', rationale: 'still there' },
    ];
    updateListeners[0]({ transactions: [], docChanged: true });
    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(ext._findings.map(f => f.old), ['BBB']);
    assert.strictEqual(lintCalls.at(-1).own.length, 1);
  });

  it('does not re-render when every finding still matches', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({ docText: 'x AAA y' });
    await ext.start();
    ext._pruneDelayMs = 1;
    ext._findings = [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }];
    updateListeners[0]({ transactions: [], docChanged: true });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(lintCalls.length, 0);
  });

  it('debounces bursts of edits into one check', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({ docText: 'x y' });
    await ext.start();
    ext._pruneDelayMs = 10;
    ext._findings = [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }];
    for (let i = 0; i < 5; i++) updateListeners[0]({ transactions: [], docChanged: true });
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(lintCalls.length, 1);
  });
});

describe('plan request', () => {
  const rules = [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }];

  it('asks for the chunk count before any review request and reports it to onStart', async () => {
    const endpoints = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      chunkCount: 2,
      callPluginApiImpl: async (endpoint) => { endpoints.push(endpoint); return { findings: [], chunk_count: 2 }; },
    });
    const started = [];
    await ext.review(undefined, { onStart: (t) => started.push(t) });
    assert.deepStrictEqual(started, [2]);
    assert.deepStrictEqual(endpoints, ['/api/plugins/annotation-review/review', '/api/plugins/annotation-review/review']);
  });

  it('notifies and returns null when the plan request fails', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      planImpl: async () => { throw new Error('not well-formed'); },
    });
    assert.strictEqual(await ext.review(), null);
    assert.match(notifyCalls.at(-1)[0], /not well-formed/);
  });
});

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
  const lintCalls = [], updateListeners = [], mergeViews = [], menuAdds = [], spinnerCalls = [], handlers = {};
  ext._deps = {
    tools: { addMenuItems: (items, category) => menuAdds.push({ items, category }) },
    ui: { spinner: { show: (m) => spinnerCalls.push(['show', m]), hide: () => spinnerCalls.push(['hide']) } },
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
    },
  };
  if (opts.state) ext.state = opts.state;
  ext.callPluginApi = opts.callPluginApiImpl ?? (async () => { throw new Error('unexpected call'); });
  return { ext, notifyCalls, lintCalls, updateListeners, mergeViews, menuAdds, spinnerCalls, handlers };
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

  it('shows a spinner, displays findings and reports the count', async () => {
    const { ext, spinnerCalls, notifyCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'x AAA y',
      callPluginApiImpl: async () => ({ findings: [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }] }),
    });
    await ext.runReview();
    assert.deepStrictEqual(spinnerCalls.map(c => c[0]), ['show', 'hide']);
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

  it('hides the spinner and shows nothing when review() fails', async () => {
    const { ext, spinnerCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      callPluginApiImpl: async () => { throw new Error('boom'); },
    });
    await ext.runReview();
    assert.deepStrictEqual(spinnerCalls.map(c => c[0]), ['show', 'hide']);
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

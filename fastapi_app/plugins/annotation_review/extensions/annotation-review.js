/**
 * Annotation Review frontend extension.
 *
 * Adds a "Review Annotations" item to the Tools menu (annotation category),
 * enabled only when the open document has machine-readable rules. Running it
 * calls the backend review endpoint and shows the findings as diagnostics
 * merged into the editor's diagnostic set, each with a "Propose fix" action
 * that opens the merge view. See
 * docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
 * for the design rationale.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { Diagnostic } from '@codemirror/lint'
 */

/** Diagnostic source tag identifying this plugin's diagnostics. */
const SOURCE = 'annotation-review';

/**
 * @typedef {{id: number, old: string, new: string, rationale: string}} Finding
 */

/**
 * Locate the single occurrence of `finding.old` in the current document text.
 * Returns null when it is absent or ambiguous - the document may have changed
 * since the review request was sent, and such findings are dropped silently.
 * @param {Finding} finding
 * @param {string} docText
 * @returns {{from: number, to: number}|null}
 */
export function locateFinding(finding, docText) {
  const from = docText.indexOf(finding.old);
  if (from === -1 || docText.indexOf(finding.old, from + 1) !== -1) return null;
  return { from, to: from + finding.old.length };
}

/**
 * Build the document text with only this finding applied, for the merge view.
 * Returns null if the text at [from, to) is no longer exactly `finding.old`.
 * @param {string} docText
 * @param {number} from
 * @param {number} to
 * @param {Finding} finding
 * @returns {string|null}
 */
export function buildModifiedText(docText, from, to, finding) {
  if (docText.slice(from, to) !== finding.old) return null;
  return docText.slice(0, from) + finding.new + docText.slice(to);
}

/**
 * Turn findings into CodeMirror diagnostics positioned in the current text.
 * @param {Finding[]} findings
 * @param {string} docText
 * @param {(finding: Finding, from: number, to: number) => void} onProposeFix
 * @returns {Diagnostic[]}
 */
export function findingsToDiagnostics(findings, docText, onProposeFix) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  for (const finding of findings) {
    const range = locateFinding(finding, docText);
    if (!range) continue;
    diagnostics.push({
      from: range.from,
      to: range.to,
      severity: 'info',
      message: finding.rationale,
      actions: [{
        name: 'Propose fix',
        apply: (_view, from, to) => onProposeFix(finding, from, to),
      }],
    });
  }
  return diagnostics;
}

export default class AnnotationReviewExtension extends FrontendExtensionPlugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, { name: 'annotation-review', deps: ['xmleditor', 'tools'] });
    /** @type {Finding[]} Findings of the last review, shown as diagnostics. */
    this._findings = [];
    /** @type {boolean} True while this plugin dispatches its own diagnostics. */
    this._rendering = false;
    /** @type {HTMLElement|undefined} The Tools-menu item, created in start(). */
    this._menuItem = undefined;
  }

  /**
   * Add the Tools-menu item and re-merge stored findings whenever another
   * source replaces the diagnostics.
   * @returns {Promise<void>}
   */
  async start() {
    const item = document.createElement('sl-menu-item');
    item.textContent = 'Review Annotations';
    item.disabled = true;
    item.addEventListener('click', () => this.runReview());
    this._menuItem = item;
    this.getDependency('tools').addMenuItems([item], 'annotation');
    const xmleditor = this.getDependency('xmleditor');
    xmleditor.on('editorReady', () => this._updateMenuState());
    this._updateMenuState();

    xmleditor.addUpdateListener(update => {
      if (this.getDependency('lint-utils').replacesDiagnostics(update) && !this._rendering && this._findings.length) {
        // CodeMirror forbids dispatching from inside an update listener
        setTimeout(() => this._renderFindings(false), 0);
      }
    });
  }

  /**
   * Store findings and display them as diagnostics.
   * @param {Finding[]} findings
   * @returns {void}
   */
  showFindings(findings) {
    this._findings = findings;
    this._renderFindings(true);
  }

  /**
   * Remove all findings and their diagnostics.
   * @returns {void}
   */
  clearFindings() {
    if (!this._findings.length) return;
    this._findings = [];
    this._renderFindings();
  }

  /**
   * Merge diagnostics for the stored findings into the editor's diagnostics.
   * @param {boolean} [openPanel] Open the lint panel if it is closed (only for user-initiated display)
   * @returns {void}
   */
  _renderFindings(openPanel = false) {
    const view = this.getDependency('xmleditor').getView();
    const own = findingsToDiagnostics(
      this._findings,
      view.state.doc.toString(),
      (finding, from, to) => this._proposeFix(finding, from, to)
    );
    this._rendering = true;
    try {
      this.getDependency('lint-utils').applyMergedDiagnostics(view, SOURCE, own, { openPanel });
    } finally {
      this._rendering = false;
    }
  }

  /**
   * Open the merge view showing only the given finding's change.
   * @param {Finding} finding
   * @param {number} from
   * @param {number} to
   * @returns {Promise<void>}
   */
  async _proposeFix(finding, from, to) {
    const xmleditor = this.getDependency('xmleditor');
    const modified = buildModifiedText(xmleditor.getView().state.doc.toString(), from, to, finding);
    if (modified === null) {
      this.getDependency('sl-utils').notify(
        'The document changed; this finding no longer applies.',
        'warning',
        'exclamation-triangle'
      );
      return;
    }
    try {
      await xmleditor.showMergeView(modified);
    } catch (err) {
      this.getDependency('sl-utils').notify(
        `Could not show the proposed fix: ${err.message}`,
        'danger',
        'exclamation-octagon'
      );
    }
  }

  /**
   * A different document was loaded; drop stale findings.
   * @param {string} [_doc] New document identifier
   * @returns {Promise<void>}
   */
  async onXmlChange(_doc) {
    this.clearFindings();
    this._updateMenuState();
  }

  /**
   * Enable the menu item only if a document is open and has reviewable rules.
   * No-op before start() has created the item.
   * @returns {void}
   */
  _updateMenuState() {
    if (!this._menuItem) return;
    const tree = this.getDependency('xmleditor').getXmlTree();
    this._menuItem.disabled = !tree || !this.hasReviewableRules(tree);
  }

  /**
   * Run a review with a spinner, show the findings and report the result.
   * review() notifies on its own failure paths, so a null result is silent.
   * @param {{providerId: string, modelId: string}} [override]
   * @returns {Promise<void>}
   */
  async runReview(override) {
    const ui = this.getDependency('ui');
    ui.spinner.show('Reviewing annotations…');
    const xmlBefore = this.state?.xml;
    try {
      const findings = await this.review(override);
      if (findings === null) return;
      // findings from a different document must not attach to another one
      if (this.state?.xml !== xmlBefore) return;
      this.showFindings(findings);
      const count = findings.length;
      this.getDependency('sl-utils').notify(
        count ? `${count} suggestion(s) - see the highlighted passages.` : 'No issues found.',
        count ? 'primary' : 'success',
        count ? 'info-circle' : 'check-circle'
      );
    } finally {
      ui.spinner.hide();
    }
  }

  /**
   * True if the given document has at least one editorialDecl category with
   * a "machine"-subtype ref — i.e. there is something to review against.
   * @param {Document} xmlDoc
   * @returns {boolean}
   */
  hasReviewableRules(xmlDoc) {
    const guides = this.getDependency('tei-utils').getEditorialDeclGuides(xmlDoc);
    return guides.some(g => g.refs.some(r => r.subtype === 'machine'));
  }

  /**
   * Review the current editor document's annotations against its own
   * editorialDecl rules. Resolves provider/model from the given override,
   * or from the shared default (Part F), unless one isn't configured.
   * @param {{providerId: string, modelId: string}} [override]
   * @returns {Promise<Array<{id: number, old: string, new: string, rationale: string}>|null>}
   *   null when the review could not be started or failed (user already notified).
   */
  async review(override) {
    const xmleditorApi = this.getDependency('xmleditor');
    const xmlDoc = xmleditorApi.getXmlTree();
    if (!xmlDoc) {
      this.getDependency('sl-utils').notify('No document open.', 'warning', 'exclamation-triangle');
      return null;
    }

    if (!this.hasReviewableRules(xmlDoc)) {
      this.getDependency('sl-utils').notify(
        'This document has no machine-readable annotation rules to review against.',
        'warning',
        'exclamation-triangle'
      );
      return null;
    }

    const resolved = override ?? this.getDependency('inference-settings').getDefaultModel();
    if (!resolved) {
      this.getDependency('sl-utils').notify(
        'No default model configured. Set one via Tools → Inference → Default Model.',
        'warning',
        'exclamation-triangle'
      );
      return null;
    }

    try {
      const { findings } = await this.callPluginApi(
        '/api/plugins/annotation-review/review',
        'POST',
        {
          xml: xmleditorApi.getEditorContent(),
          provider_id: resolved.providerId,
          model_id: resolved.modelId,
        }
      );
      return findings;
    } catch (err) {
      this.getDependency('sl-utils').notify(
        `Annotation review failed: ${err.message}`,
        'danger',
        'exclamation-octagon'
      );
      return null;
    }
  }
}

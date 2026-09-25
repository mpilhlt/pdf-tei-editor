/**
 * Annotation Review frontend extension.
 *
 * Exposes review()/hasReviewableRules() for later parts (D: Tools-menu
 * trigger, E: diagnostics UI) to call. Does not itself add any menu item
 * or diagnostics source — see
 * docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
 * (Part C) for the design rationale and scope split.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class AnnotationReviewExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'annotation-review', deps: [] });
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

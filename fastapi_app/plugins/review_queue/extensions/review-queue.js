/**
 * @file Frontend Extension: Review Queue
 * Contributes a "Waiting for review" box to the dashboard listing all accessible documents
 * whose lifecycle status is one of the configured statuses. Clicking a document opens it.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { DashboardContribution } from '../../dashboard/extensions/dashboard.js'
 */

/**
 * @typedef {object} QueuedDocument
 * @property {string} stable_id
 * @property {string|null} pdf_stable_id
 * @property {string} doc_id
 * @property {string} title - Document (PDF) label
 * @property {string|null} label - TEI file label
 * @property {string|null} variant
 * @property {string|null} status
 * @property {string[]} collections
 * @property {string} project
 * @property {string} updated_at
 */

/** Rows the box asks for at most */
const MAX_ROWS = 3;

export default class ReviewQueueExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'review-queue' });
  }

  static extensionPoints = ['dashboard.contributions'];

  /**
   * Extension point handler for `dashboard.contributions`.
   * Called by the dashboard extension when it opens, to collect this plugin's box.
   * Delegates to {@link ReviewQueueExtension#getContributions}.
   * @returns {Promise<DashboardContribution[]>}
   */
  async ['dashboard.contributions']() {
    return this.getContributions();
  }

  /**
   * Fetches the documents waiting for review and builds the dashboard box.
   * @returns {Promise<DashboardContribution[]>} An empty array if no document waits for review
   */
  async getContributions() {
    /** @type {{ statuses: string[], documents: QueuedDocument[] }} */
    const data = await this.callPluginApi('/api/plugins/review-queue/documents');
    const documents = data.documents || [];
    if (documents.length === 0) {
      return [];
    }

    const dashboard = this.getDependency('dashboard');
    const showStatus = (data.statuses || []).length > 1;
    const element = dashboard.renderDocumentList([{
      items: documents.map(doc => ({
        title: doc.title,
        link: doc.label || doc.variant || 'TEI',
        linkTitle: [doc.label, doc.variant].filter(Boolean).join(' · ') || undefined,
        status: showStatus ? doc.status : null,
        time: doc.updated_at,
        testId: `review-queue-item-${doc.stable_id}`,
        onClick: () => dashboard.openDocument(doc.stable_id, doc.pdf_stable_id, doc.collections[0] || null)
      }))
    }]);

    return [{
      id: 'review-queue',
      title: `Waiting for review (${documents.length})`,
      icon: 'hourglass-split',
      element,
      cols: 1,
      rows: Math.min(MAX_ROWS, Math.max(1, Math.ceil(documents.length / 4))),
      priority: 60
    }];
  }
}

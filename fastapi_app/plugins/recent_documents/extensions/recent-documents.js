/**
 * @file Frontend Extension: Recent Documents
 * Contributes a "Recently edited" box to the dashboard: up to five documents per project
 * that the user edited last, projects ordered by their most recent edit. Clicking a
 * document's TEI label opens it.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { DashboardContribution, DashboardDocumentGroup } from '../../dashboard/extensions/dashboard.js'
 */

/**
 * @typedef {object} RecentDocument
 * @property {string} stable_id
 * @property {string|null} pdf_stable_id
 * @property {string} doc_id
 * @property {string} title - Document (PDF) label
 * @property {string|null} label - TEI file label
 * @property {string|null} variant
 * @property {string|null} status
 * @property {string[]} collections
 * @property {string} edited_at
 */

/**
 * @typedef {object} RecentProject
 * @property {string} id
 * @property {string} name
 * @property {RecentDocument[]} documents
 */

/** Rows the box asks for at most */
const MAX_ROWS = 4;

/**
 * Number of grid rows for a list with the given number of lines (headings and documents).
 * @param {number} lines
 * @returns {number}
 */
export function rowsForLines(lines) {
  return Math.min(MAX_ROWS, Math.max(1, Math.ceil(lines / 4)));
}

export default class RecentDocumentsExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'recent-documents' });
  }

  static extensionPoints = ['dashboard.contributions'];

  /**
   * Extension point handler for `dashboard.contributions`.
   * Called by the dashboard extension when it opens, to collect this plugin's box.
   * Delegates to {@link RecentDocumentsExtension#getContributions}.
   * @returns {Promise<DashboardContribution[]>}
   */
  async ['dashboard.contributions']() {
    return this.getContributions();
  }

  /**
   * Fetches the user's recently edited documents and builds the dashboard box.
   * @returns {Promise<DashboardContribution[]>} An empty array if there are none
   */
  async getContributions() {
    /** @type {{ projects: RecentProject[] }} */
    const data = await this.callPluginApi('/api/plugins/recent-documents/recent');
    const projects = data.projects || [];
    if (projects.length === 0) {
      return [];
    }

    const dashboard = this.getDependency('dashboard');
    /** @type {DashboardDocumentGroup[]} */
    const groups = projects.map(project => ({
      heading: project.name,
      items: project.documents.map(doc => ({
        title: doc.title,
        link: doc.label || doc.variant || 'TEI',
        linkTitle: [doc.label, doc.variant].filter(Boolean).join(' · ') || undefined,
        status: doc.status,
        time: doc.edited_at,
        testId: `recent-documents-item-${doc.stable_id}`,
        onClick: () => dashboard.openDocument(doc.stable_id, doc.pdf_stable_id, doc.collections[0] || null)
      }))
    }));
    const lines = projects.reduce((sum, project) => sum + 1 + project.documents.length, 0);

    return [{
      id: 'recent-documents',
      title: 'Recently edited',
      icon: 'clock-history',
      element: dashboard.renderDocumentList(groups),
      cols: 1,
      rows: rowsForLines(lines),
      priority: 100
    }];
  }
}

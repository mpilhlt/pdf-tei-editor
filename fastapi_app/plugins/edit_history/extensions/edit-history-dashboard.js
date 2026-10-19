/**
 * @file Frontend Extension: Edit History (dashboard box)
 * Contributes a "Recent edits" box to the dashboard: the latest changes in the non-archived
 * projects the user can access, with who made them. Clicking a change opens the document; the
 * "See all" link in the title bar opens the edit history of all projects. Only used if the
 * dashboard plugin is active; otherwise nobody invokes `dashboard.contributions`.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { DashboardContribution } from '../../dashboard/extensions/dashboard.js'
 */

/**
 * @typedef {object} RecentEdit
 * @property {string} stable_id - TEI file
 * @property {string|null} pdf_stable_id
 * @property {string} title - Document (PDF) label
 * @property {string|null} label - TEI file label
 * @property {string|null} variant
 * @property {string[]} collections
 * @property {string} description - Description of the change
 * @property {string} who - Who made the change
 * @property {string} change_status - Status set by the change
 * @property {string} when - ISO timestamp of the change
 */

/** Number of changes shown */
const EDIT_COUNT = 10;

/** Rows the box asks for at most */
const MAX_ROWS = 3;

export default class EditHistoryDashboardExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'edit-history-dashboard', deps: ['backend-plugins'] });
  }

  static extensionPoints = ['dashboard.contributions'];

  /**
   * Extension point handler for `dashboard.contributions`.
   * Called by the dashboard extension when it opens, to collect this plugin's box.
   * Delegates to {@link EditHistoryDashboardExtension#getContributions}.
   * @returns {Promise<DashboardContribution[]>}
   */
  async ['dashboard.contributions']() {
    return this.getContributions();
  }

  /**
   * Fetches the recent changes and builds the dashboard box.
   * @returns {Promise<DashboardContribution[]>} An empty array if there are no changes
   */
  async getContributions() {
    /** @type {{ edits: RecentEdit[] }} */
    const data = await this.callPluginApi(`/api/plugins/edit-history/recent?limit=${EDIT_COUNT}`);
    const edits = data.edits || [];
    if (edits.length === 0) {
      return [];
    }

    const dashboard = this.getDependency('dashboard');
    const element = dashboard.renderDocumentList([{
      items: edits.map(edit => ({
        title: edit.title,
        link: edit.description || edit.label || edit.variant || 'Change',
        linkTitle: [edit.label, edit.variant].filter(Boolean).join(' · ') || undefined,
        detail: edit.who,
        status: edit.change_status,
        time: edit.when,
        testId: `edit-history-item-${edit.stable_id}`,
        onClick: () => dashboard.openDocument(edit.stable_id, edit.pdf_stable_id, edit.collections[0] || null)
      }))
    }]);

    return [{
      id: 'edit-history',
      title: 'Recent edits',
      icon: 'clock-history',
      element,
      cols: 1,
      rows: Math.min(MAX_ROWS, Math.max(1, Math.ceil(edits.length / 4))),
      priority: 70,
      action: { label: 'See all', onClick: () => this.showAll() }
    }];
  }

  /**
   * Closes the dashboard and opens the edit history of all accessible projects.
   */
  async showAll() {
    await this.getDependency('dashboard').close();
    await this.getDependency('backend-plugins').execute('edit-history', 'show_all', {});
  }
}

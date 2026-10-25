/**
 * @file Frontend Extension: Dashboard
 * Shows a two-column dashboard in a dialog after login (once per login session, not when the
 * page was opened with a link to a backend plugin view, not on page
 * reloads). Other plugins contribute boxes through the `dashboard.contributions` extension
 * point; the dashboard is only shown if at least one box is contributed. An info button in
 * the toolbar, after the file drawer button, reopens it.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { InvocationResult } from '../../../../app/src/modules/plugin-manager.js'
 */

/**
 * A box contributed to the dashboard by a plugin implementing `dashboard.contributions`.
 * @typedef {object} DashboardContribution
 * @property {string} id - Unique id of the box (used for test ids)
 * @property {string} title - Box title
 * @property {string} [icon] - Shoelace icon name shown before the title
 * @property {HTMLElement} element - Box content; scrolls if it overflows the box
 * @property {1|2} [cols=1] - Number of columns the box occupies
 * @property {number} [rows=1] - Number of rows the box occupies
 * @property {number} [priority=0] - Higher priorities are placed first
 * @property {DashboardAction} [action] - Link shown at the right of the title bar, e.g. "See all"
 */

/**
 * A link in the title bar of a dashboard box.
 * @typedef {object} DashboardAction
 * @property {string} label
 * @property {() => void} onClick
 */

/**
 * Position of a contribution in the dashboard grid (zero-based).
 * @typedef {object} DashboardPlacement
 * @property {DashboardContribution} item
 * @property {number} col
 * @property {number} row
 * @property {number} colSpan
 * @property {number} rowSpan
 */

/**
 * A document row rendered by {@link DashboardExtension#renderDocumentList}.
 * @typedef {object} DashboardDocumentItem
 * @property {string} title - Document (PDF) label, plain text
 * @property {string} link - TEI file label, rendered as the link that opens the document
 * @property {string} [linkTitle] - Tooltip of the link
 * @property {string} [detail] - Secondary text shown after the link
 * @property {string|null} [status] - Lifecycle status, rendered as a badge
 * @property {string|null} [time] - ISO timestamp, rendered as relative time
 * @property {string} [testId] - `data-test-id` of the row
 * @property {() => void} onClick - Called when the link is clicked
 */

/**
 * A group of document rows with an optional heading.
 * @typedef {object} DashboardDocumentGroup
 * @property {string} [heading]
 * @property {DashboardDocumentItem[]} items
 */

/** Minimum height of a grid row in pixels; the dashboard scrolls beyond that */
const MIN_ROW_HEIGHT = 90;

/** Preferred height of a grid row in pixels; the grid never grows beyond 65% of the viewport */
const PREFERRED_ROW_HEIGHT = 150;

/**
 * Packs contributions into a two-column grid without empty cells.
 *
 * Boxes are taken in priority order (highest first, stable). A one-column box goes into
 * the shorter column. Before a two-column box, the columns are levelled: the gap is filled
 * with the first remaining one-column box of exactly the gap's height, otherwise the last
 * box of the shorter column is stretched. If the shorter column has no box above the gap
 * (since the last full-width box), the boxes of the taller column are widened instead.
 * The columns are levelled the same way at the end.
 *
 * @param {DashboardContribution[]} items
 * @returns {{ placements: DashboardPlacement[], rows: number }}
 */
export function packDashboard(items) {
  const queue = items
    .map((item, index) => ({
      item,
      index,
      cols: item.cols === 2 ? 2 : 1,
      rows: Math.max(1, Math.round(Number(item.rows) || 1)),
      priority: Number(item.priority) || 0
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  /** @type {DashboardPlacement[]} */
  const placements = [];
  const heights = [0, 0];
  /** @type {DashboardPlacement[][]} boxes of each column since the last full-width box */
  let segment = [[], []];

  /**
   * @param {typeof queue[number]} entry
   * @param {number} col
   */
  const placeInColumn = (entry, col) => {
    const placement = { item: entry.item, col, row: heights[col], colSpan: 1, rowSpan: entry.rows };
    placements.push(placement);
    segment[col].push(placement);
    heights[col] += entry.rows;
  };

  /** @param {typeof queue} remaining - candidates for filling gaps, may be empty */
  const level = (remaining) => {
    while (heights[0] !== heights[1]) {
      const short = heights[0] < heights[1] ? 0 : 1;
      const tall = 1 - short;
      const gap = heights[tall] - heights[short];
      const fillIndex = remaining.findIndex(entry => entry.cols === 1 && entry.rows === gap);
      if (fillIndex >= 0) {
        placeInColumn(remaining.splice(fillIndex, 1)[0], short);
      } else if (segment[short].length > 0) {
        segment[short][segment[short].length - 1].rowSpan += gap;
        heights[short] += gap;
      } else {
        for (const placement of segment[tall]) {
          placement.col = 0;
          placement.colSpan = 2;
        }
        heights[short] = heights[tall];
      }
    }
  };

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry.cols === 1) {
      placeInColumn(entry, heights[1] < heights[0] ? 1 : 0);
      continue;
    }
    level(queue);
    placements.push({ item: entry.item, col: 0, row: heights[0], colSpan: 2, rowSpan: entry.rows });
    heights[0] += entry.rows;
    heights[1] += entry.rows;
    segment = [[], []];
  }
  level([]);

  return { placements, rows: heights[0] };
}

/**
 * Formats a timestamp relative to now ("5 min", "3 h", "2 d", or a date for older ones).
 * @param {string|null|undefined} isoTimestamp
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRelativeTime(isoTimestamp, now = new Date()) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d`;
  return date.toLocaleDateString();
}

/**
 * Checks that a value returned by a `dashboard.contributions` handler is a usable contribution.
 * @param {any} item
 * @returns {item is DashboardContribution}
 */
export function isValidContribution(item) {
  return Boolean(item)
    && typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof HTMLElement !== 'undefined'
    && item.element instanceof HTMLElement;
}

export default class DashboardExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'dashboard', deps: ['config'] });
    this.#openedWithPluginLink = new URLSearchParams(window.location.hash.slice(1)).has('plugin');
  }

  static extensionPoints = ['toolbar.contentItems'];

  /** @type {HTMLElement} */
  #dialog = null;

  /** @type {HTMLElement} */
  #grid = null;

  /** @type {HTMLElement} */
  #emptyMessage = null;

  /** @type {HTMLElement} */
  #toolbarButton = null;

  /** Whether `ready()` has run, so later session changes are logins */
  #isReady = false;

  /**
   * Whether the page was opened with a link to a backend plugin view (`#plugin=...`, see
   * backend-plugins.js), which the dashboard must not cover. Read on construction, before
   * backend-plugins removes the parameter from the URL hash.
   */
  #openedWithPluginLink = false;

  /**
   * @param {Object} state - Initial application state
   */
  async install(state) {
    await super.install(state);
    this.#buildDialog();

    this.#toolbarButton = document.createElement('sl-button');
    this.#toolbarButton.setAttribute('name', 'dashboardBtn');
    this.#toolbarButton.setAttribute('size', 'small');
    this.#toolbarButton.setAttribute('title', 'Show dashboard');
    this.#toolbarButton.dataset.testId = 'dashboard-toolbar-btn';
    this.#toolbarButton.innerHTML = '<sl-icon name="info-circle"></sl-icon>';
    this.#toolbarButton.style.display = state.user ? '' : 'none';
    this.#toolbarButton.addEventListener('click', () => this.open());
  }

  /**
   * Extension point handler for `toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect the dashboard button, which goes into the
   * left zone right after the file drawer button (priority 10).
   * Delegates to {@link DashboardExtension#getToolbarItems}.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  ['toolbar.contentItems']() {
    return this.getToolbarItems();
  }

  /**
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  getToolbarItems() {
    return [{ element: this.#toolbarButton, priority: 9.5, position: 'left' }];
  }

  /**
   * Shows the dashboard once the application has started and restored the last document,
   * if this is the first page load of the login session.
   */
  async ready() {
    this.#isReady = true;
    await this.#showAfterLogin();
  }

  /**
   * @param {object|null} user
   */
  async onUserChange(user) {
    if (this.#toolbarButton) {
      this.#toolbarButton.style.display = user ? '' : 'none';
    }
  }

  /**
   * Shows the dashboard after a login that happens while the application is running.
   * @param {string|null} sessionId
   */
  async onSessionIdChange(sessionId) {
    if (this.#isReady && sessionId) {
      await this.#showAfterLogin();
    }
  }

  /**
   * Opens the dashboard once per login session (identified by the session id), if the
   * configuration and the user's "Show on login" preference allow it and at least one plugin
   * contributes a box. Page reloads within the same session do not show it again.
   */
  async #showAfterLogin() {
    const sessionId = this.state?.sessionId;
    if (!sessionId || this.uiStorage.get('shownForSession') === sessionId) {
      return;
    }
    if (this.#openedWithPluginLink) {
      // the linked plugin view is shown instead; don't show the dashboard on reloads either
      this.uiStorage.set('shownForSession', sessionId);
      return;
    }
    const showOnLogin = await this.getDependency('config').get('plugin.dashboard.show-on-login', true);
    if (showOnLogin === false || !this.uiStorage.get('showOnLogin', true)) {
      return;
    }
    if (await this.open({ onlyIfContributions: true })) {
      this.uiStorage.set('shownForSession', sessionId);
    }
  }

  /**
   * Collects the contributions, renders them and opens the dashboard dialog.
   * @param {{ onlyIfContributions?: boolean }} [options] - If `onlyIfContributions` is true,
   *   the dialog stays closed when no plugin contributes a box
   * @returns {Promise<boolean>} Whether the dialog was opened
   */
  async open({ onlyIfContributions = false } = {}) {
    const contributions = await this.collectContributions();
    if (contributions.length === 0 && onlyIfContributions) {
      return false;
    }
    this.#render(contributions);
    const user = this.state?.user;
    const name = user?.fullname || user?.username;
    this.#dialog.label = name || 'Dashboard';
    await this.#dialog.show();
    return true;
  }

  /**
   * Closes the dashboard dialog. Called by contributing plugins after they opened a document.
   * @returns {Promise<void>}
   */
  async close() {
    await this.#dialog.hide();
  }

  /**
   * Opens a document in the editor and closes the dashboard. Shared helper for contributions
   * that list documents.
   * @param {string} xml - Stable id of the TEI file
   * @param {string|null} [pdf] - Stable id of the PDF file, if any
   * @param {string|null} [collection] - Collection to select in the file selection
   * @returns {Promise<void>}
   */
  async openDocument(xml, pdf = null, collection = null) {
    await this.close();
    if (collection) {
      await this.dispatchStateChange({ collection });
    }
    await this.getDependency('services').load({ xml, pdf: pdf || undefined });
  }

  /**
   * Renders grouped document rows in the dashboard's common style. Shared helper for
   * contributions that list documents. Rows are table rows with aligned columns; in lists narrower
   * than 600px each row wraps to two lines (labels and time, then link, detail and status).
   * @param {DashboardDocumentGroup[]} groups
   * @returns {HTMLElement}
   */
  renderDocumentList(groups) {
    const items = groups.flatMap(group => group.items);
    /** @type {Array<{ name: string, width: string, has: boolean }>} */
    const columns = [
      { name: 'title', width: 'minmax(0, 1fr)', has: true },
      { name: 'link', width: 'fit-content(40%)', has: true },
      { name: 'detail', width: 'fit-content(25%)', has: items.some(item => item.detail) },
      { name: 'status', width: 'max-content', has: items.some(item => item.status) },
      { name: 'time', width: 'max-content', has: items.some(item => item.time !== undefined) }
    ].filter(column => column.has);

    const container = document.createElement('div');
    container.className = 'dashboard-doc-list';
    const list = document.createElement('div');
    list.className = 'dashboard-doc-table';
    list.style.gridTemplateColumns = columns.map(column => column.width).join(' ');
    container.appendChild(list);

    for (const group of groups) {
      if (group.heading) {
        const heading = document.createElement('div');
        heading.className = 'dashboard-doc-heading';
        const name = document.createElement('span');
        name.textContent = group.heading;
        const count = document.createElement('span');
        count.textContent = `${group.items.length} ${group.items.length === 1 ? 'doc' : 'docs'}`;
        heading.append(name, count);
        list.appendChild(heading);
      }
      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'dashboard-doc';
        if (item.testId) row.dataset.testId = item.testId;
        for (const column of columns) {
          row.appendChild(this.#renderDocumentCell(column.name, item));
        }
        list.appendChild(row);
      }
    }
    return container;
  }

  /**
   * @param {string} column - `title`, `link`, `detail`, `status` or `time`
   * @param {DashboardDocumentItem} item
   * @returns {HTMLElement} The cell; empty if the item has no value for the column
   */
  #renderDocumentCell(column, item) {
    if (column === 'link') {
      const link = document.createElement('a');
      link.className = 'dashboard-doc-link';
      link.href = '#';
      link.textContent = item.link;
      link.title = item.linkTitle || item.link;
      link.addEventListener('click', event => {
        event.preventDefault();
        item.onClick();
      });
      return link;
    }
    const cell = document.createElement('span');
    cell.className = `dashboard-doc-${column}`;
    if (column === 'title' || column === 'detail') {
      cell.textContent = item[column] || '';
      cell.title = item[column] || '';
    } else if (column === 'status' && item.status) {
      const badge = document.createElement('span');
      badge.className = 'dashboard-doc-badge';
      badge.textContent = item.status;
      cell.appendChild(badge);
    } else if (column === 'time' && item.time !== undefined) {
      cell.textContent = formatRelativeTime(item.time);
    }
    return cell;
  }

  /**
   * Invokes the `dashboard.contributions` extension point and returns the valid contributions.
   * @returns {Promise<DashboardContribution[]>}
   */
  async collectContributions() {
    /** @type {InvocationResult[]} */
    const results = await this.context.invokePluginEndpoint(
      'dashboard.contributions', [], { result: 'full', throws: false }
    );
    return (results || [])
      .flatMap(result => {
        if (result.status === 'rejected') {
          console.warn('A dashboard contribution failed:', result.reason);
          return [];
        }
        return Array.isArray(result.value) ? result.value : [];
      })
      .filter(isValidContribution);
  }

  #buildDialog() {
    this.#dialog = document.createElement('sl-dialog');
    this.#dialog.label = 'Dashboard';
    this.#dialog.dataset.testId = 'dashboard-dialog';
    this.#dialog.style.setProperty('--width', 'min(1100px, 92vw)');

    const style = document.createElement('style');
    style.textContent = `
      .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
      .dashboard-box { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--sl-color-neutral-200);
        border-radius: var(--sl-border-radius-medium); background: var(--sl-color-neutral-0); }
      .dashboard-box-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-weight: var(--sl-font-weight-semibold);
        font-size: var(--sl-font-size-small); border-bottom: 1px solid var(--sl-color-neutral-200); }
      .dashboard-box-header sl-icon { color: var(--sl-color-primary-600); }
      .dashboard-box-action { margin-left: auto; font-weight: var(--sl-font-weight-normal); font-size: var(--sl-font-size-x-small);
        color: var(--sl-color-primary-700); text-decoration: none; }
      .dashboard-box-action:hover, .dashboard-box-action:focus-visible { text-decoration: underline; }
      .dashboard-box-body { flex: 1; min-height: 0; overflow: auto; font-size: var(--sl-font-size-small); }
      .dashboard-empty { color: var(--sl-color-neutral-600); }
      .dashboard-doc-table { display: grid; column-gap: 10px; }
      .dashboard-doc-heading { grid-column: 1 / -1; display: flex; justify-content: space-between; padding: 8px 10px 2px;
        font-size: var(--sl-font-size-x-small); text-transform: uppercase; letter-spacing: .04em; color: var(--sl-color-neutral-600); }
      .dashboard-doc { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: baseline; padding: 3px 10px; }
      .dashboard-doc:hover { background: var(--sl-color-neutral-50); }
      .dashboard-doc > * { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dashboard-doc-title { color: var(--sl-color-neutral-800); }
      .dashboard-doc-link { color: var(--sl-color-primary-700); text-decoration: none; }
      .dashboard-doc-link:hover, .dashboard-doc-link:focus-visible { text-decoration: underline; }
      .dashboard-doc-detail { color: var(--sl-color-neutral-600); }
      .dashboard-doc-badge { font-size: var(--sl-font-size-x-small); border-radius: 9px; padding: 0 6px;
        background: var(--sl-color-neutral-100); color: var(--sl-color-neutral-700); }
      .dashboard-doc-time { font-size: var(--sl-font-size-x-small); color: var(--sl-color-neutral-500); text-align: right; }
      .dashboard-doc-list { container-type: inline-size; }
      @container (max-width: 600px) {
        .dashboard-doc-table { display: block; }
        .dashboard-doc { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, max-content) max-content;
          grid-template-areas: "title title time" "link detail status"; column-gap: 8px; padding: 4px 10px;
          border-bottom: 1px solid var(--sl-color-neutral-100); }
        .dashboard-doc-title { grid-area: title; }
        .dashboard-doc-time { grid-area: time; }
        .dashboard-doc-link { grid-area: link; }
        .dashboard-doc-detail { grid-area: detail; font-size: var(--sl-font-size-x-small); }
        .dashboard-doc-status { grid-area: status; }
      }
    `;
    this.#dialog.appendChild(style);

    this.#grid = document.createElement('div');
    this.#grid.className = 'dashboard-grid';
    this.#dialog.appendChild(this.#grid);

    this.#emptyMessage = document.createElement('p');
    this.#emptyMessage.className = 'dashboard-empty';
    this.#emptyMessage.textContent = 'There is nothing to show on the dashboard.';
    this.#dialog.appendChild(this.#emptyMessage);

    const showOnLogin = document.createElement('sl-checkbox');
    showOnLogin.textContent = 'Show on login';
    showOnLogin.dataset.testId = 'dashboard-show-on-login';
    showOnLogin.style.marginRight = 'auto';
    this.uiStorage.bind(showOnLogin, 'checked', { key: 'showOnLogin', event: 'sl-change', default: true });

    const closeButton = document.createElement('sl-button');
    closeButton.variant = 'primary';
    closeButton.textContent = 'Close';
    closeButton.dataset.testId = 'dashboard-close-btn';
    closeButton.addEventListener('click', () => this.close());

    const footer = document.createElement('div');
    footer.slot = 'footer';
    footer.style.display = 'flex';
    footer.style.alignItems = 'center';
    footer.style.width = '100%';
    footer.append(showOnLogin, closeButton);
    this.#dialog.appendChild(footer);

    document.body.appendChild(this.#dialog);
  }

  /**
   * @param {DashboardContribution[]} contributions
   */
  #render(contributions) {
    this.#grid.replaceChildren();
    this.#emptyMessage.style.display = contributions.length === 0 ? '' : 'none';
    this.#grid.style.display = contributions.length === 0 ? 'none' : '';

    const { placements, rows } = packDashboard(contributions);
    this.#grid.style.gridTemplateRows = `repeat(${rows}, minmax(${MIN_ROW_HEIGHT}px, 1fr))`;
    this.#grid.style.height = `min(65vh, ${rows * PREFERRED_ROW_HEIGHT}px)`;

    for (const { item, col, row, colSpan, rowSpan } of placements) {
      const box = document.createElement('section');
      box.className = 'dashboard-box';
      box.dataset.testId = `dashboard-box-${item.id}`;
      box.style.gridColumn = `${col + 1} / span ${colSpan}`;
      box.style.gridRow = `${row + 1} / span ${rowSpan}`;

      const header = document.createElement('div');
      header.className = 'dashboard-box-header';
      if (item.icon) {
        const icon = document.createElement('sl-icon');
        icon.name = item.icon;
        header.appendChild(icon);
      }
      header.append(item.title);
      if (item.action) {
        const { onClick } = item.action;
        const link = document.createElement('a');
        link.className = 'dashboard-box-action';
        link.href = '#';
        link.textContent = item.action.label;
        link.dataset.testId = `dashboard-box-action-${item.id}`;
        link.addEventListener('click', event => {
          event.preventDefault();
          onClick();
        });
        header.appendChild(link);
      }

      const body = document.createElement('div');
      body.className = 'dashboard-box-body';
      body.appendChild(item.element);

      box.append(header, body);
      this.#grid.appendChild(box);
    }
  }
}

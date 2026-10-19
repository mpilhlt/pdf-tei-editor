/**
 * @file Frontend Extension: Annotation Progress (dashboard box)
 * Contributes an "Annotation progress" box to the dashboard: per project, one line per
 * collection with a progress ring per variant showing how many documents have reached the
 * configured lifecycle status. Clicking a ring opens the progress view for that collection
 * and variant. Only used if the dashboard plugin is active; otherwise nobody invokes
 * `dashboard.contributions`.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { DashboardContribution } from '../../dashboard/extensions/dashboard.js'
 */

/**
 * @typedef {object} VariantProgress
 * @property {string} variant
 * @property {number} done - Documents of this variant at or after the threshold status
 */

/**
 * @typedef {object} BatchProgress
 * @property {string} id - Collection ID
 * @property {string} name - Collection name
 * @property {number} total - Documents in the collection
 * @property {VariantProgress[]} variants
 */

/**
 * @typedef {object} ProjectProgress
 * @property {string} id
 * @property {string} name
 * @property {BatchProgress[]} batches
 */

/** Rows the box asks for at most */
const MAX_ROWS = 4;

/** Lines (project headings and collections) that fit into one grid row */
const LINES_PER_ROW = 5;

/** Diameter and stroke width of a progress ring in pixels */
const RING_SIZE = 22;
const RING_STROKE = 4;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Number of grid rows for the given projects.
 * @param {ProjectProgress[]} projects
 * @returns {number}
 */
export function rowsForProjects(projects) {
  const lines = projects.reduce((sum, project) => sum + 1 + project.batches.length, 0);
  return Math.min(MAX_ROWS, Math.max(1, Math.ceil(lines / LINES_PER_ROW)));
}

/**
 * The variants used in a project's collections, sorted, so each variant has the same ring position on every line.
 * @param {ProjectProgress} project
 * @returns {string[]}
 */
export function projectVariants(project) {
  return [...new Set(project.batches.flatMap(batch => batch.variants.map(v => v.variant)))].sort();
}

/**
 * Share of done documents over all collection and variant combinations of a project, in percent.
 * @param {ProjectProgress} project
 * @returns {number}
 */
export function projectPercentage(project) {
  let done = 0;
  let total = 0;
  for (const batch of project.batches) {
    for (const variant of batch.variants) {
      done += variant.done;
      total += batch.total;
    }
  }
  return total ? Math.round((done / total) * 100) : 0;
}

/**
 * Colour of a ring for the given fraction of done documents.
 * @param {number} fraction - 0 to 1
 * @returns {string} A CSS colour
 */
function ringColor(fraction) {
  if (fraction >= 1) return 'var(--sl-color-success-600)';
  if (fraction >= 0.5) return 'var(--sl-color-lime-600)';
  if (fraction >= 0.2) return 'var(--sl-color-warning-600)';
  return 'var(--sl-color-danger-600)';
}

/**
 * @param {number} fraction - 0 to 1
 * @returns {SVGSVGElement}
 */
function renderRing(fraction) {
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(RING_SIZE));
  svg.setAttribute('height', String(RING_SIZE));
  svg.setAttribute('viewBox', `0 0 ${RING_SIZE} ${RING_SIZE}`);
  for (const [color, length] of [['var(--sl-color-neutral-200)', circumference], [ringColor(fraction), circumference * fraction]]) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(RING_SIZE / 2));
    circle.setAttribute('cy', String(RING_SIZE / 2));
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', color);
    circle.setAttribute('stroke-width', String(RING_STROKE));
    circle.setAttribute('stroke-dasharray', `${length} ${circumference}`);
    circle.setAttribute('transform', `rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`);
    svg.appendChild(circle);
  }
  return svg;
}

export default class AnnotationProgressDashboardExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'annotation-progress-dashboard', deps: ['backend-plugins'] });
  }

  static extensionPoints = ['dashboard.contributions'];

  /**
   * Extension point handler for `dashboard.contributions`.
   * Called by the dashboard extension when it opens, to collect this plugin's box.
   * Delegates to {@link AnnotationProgressDashboardExtension#getContributions}.
   * @returns {Promise<DashboardContribution[]>}
   */
  async ['dashboard.contributions']() {
    return this.getContributions();
  }

  /**
   * Fetches the progress per project, collection and variant and builds the dashboard box.
   * @returns {Promise<DashboardContribution[]>} An empty array if no collection has documents
   */
  async getContributions() {
    /** @type {{ threshold: string, projects: ProjectProgress[] }} */
    const data = await this.callPluginApi('/api/plugins/annotation-progress/dashboard-summary');
    const projects = data.projects || [];
    if (projects.length === 0) {
      return [];
    }

    return [{
      id: 'annotation-progress',
      title: `Annotation progress (${data.threshold} or later)`,
      icon: 'graph-up-arrow',
      element: this.renderProgress(projects, data.threshold),
      cols: 1,
      rows: rowsForProjects(projects),
      priority: 50
    }];
  }

  /**
   * Opens the progress view of a collection and variant, closing the dashboard first.
   * @param {string} collection
   * @param {string} variant
   */
  async openProgressView(collection, variant) {
    this.getDependency('dashboard').close();
    await this.getDependency('backend-plugins').execute('annotation-progress', 'show_progress', { collection, variant });
  }

  /**
   * @param {ProjectProgress[]} projects
   * @param {string} threshold
   * @returns {HTMLElement}
   */
  renderProgress(projects, threshold) {
    const container = document.createElement('div');
    container.className = 'annotation-progress-rings';
    const style = document.createElement('style');
    style.textContent = `
      .annotation-progress-rings { padding: 0 10px 6px; }
      .annotation-progress-project { display: flex; justify-content: space-between; padding: 8px 0 2px; font-size: var(--sl-font-size-x-small);
        letter-spacing: .04em; color: var(--sl-color-neutral-600); }
      .annotation-progress-project span:first-child { text-transform: uppercase; }
      .annotation-progress-batch { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
      .annotation-progress-name { flex: 0 1 35%; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .annotation-progress-ring-list { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 0; }
      .annotation-progress-ring, .annotation-progress-gap { width: ${RING_SIZE + 4}px; height: ${RING_SIZE + 4}px; }
      .annotation-progress-ring { display: flex; align-items: center; justify-content: center; border: none; border-radius: 50%;
        background: none; padding: 0; cursor: pointer; }
      .annotation-progress-ring:hover, .annotation-progress-ring:focus-visible { outline: 2px solid var(--sl-color-primary-500); outline-offset: -1px; }
      .annotation-progress-total { flex: none; color: var(--sl-color-neutral-500); font-size: var(--sl-font-size-x-small); }
    `;
    container.appendChild(style);

    for (const project of projects) {
      const heading = document.createElement('div');
      heading.className = 'annotation-progress-project';
      heading.dataset.testId = `annotation-progress-project-${project.id}`;
      const name = document.createElement('span');
      name.textContent = project.name;
      const percentage = document.createElement('span');
      percentage.textContent = `${projectPercentage(project)} % ${threshold}`;
      heading.append(name, percentage);
      container.appendChild(heading);

      const variants = projectVariants(project);
      for (const batch of project.batches) {
        container.appendChild(this.#renderBatch(batch, variants, threshold));
      }
    }
    return container;
  }

  /**
   * @param {BatchProgress} batch
   * @param {string[]} variants - The project's variants, in ring order
   * @param {string} threshold
   * @returns {HTMLElement}
   */
  #renderBatch(batch, variants, threshold) {
    const line = document.createElement('div');
    line.className = 'annotation-progress-batch';
    line.dataset.testId = `annotation-progress-batch-${batch.id}`;

    const name = document.createElement('span');
    name.className = 'annotation-progress-name';
    name.textContent = batch.name;
    name.title = batch.name;

    const rings = document.createElement('span');
    rings.className = 'annotation-progress-ring-list';
    for (const variant of variants) {
      const progress = batch.variants.find(v => v.variant === variant);
      if (!progress) {
        const gap = document.createElement('span');
        gap.className = 'annotation-progress-gap';
        rings.appendChild(gap);
        continue;
      }
      const fraction = batch.total ? progress.done / batch.total : 0;
      const button = document.createElement('button');
      button.className = 'annotation-progress-ring';
      button.dataset.testId = `annotation-progress-ring-${batch.id}-${variant}`;
      button.setAttribute('aria-label', `${batch.name}, ${variant}`);
      button.appendChild(renderRing(fraction));
      button.addEventListener('click', () => this.openProgressView(batch.id, variant));

      const tooltip = document.createElement('sl-tooltip');
      tooltip.content = `${variant}: ${progress.done} / ${batch.total} ${threshold} (${Math.round(fraction * 100)} %)`;
      tooltip.hoist = true;
      tooltip.appendChild(button);
      rings.appendChild(tooltip);
    }

    const total = document.createElement('span');
    total.className = 'annotation-progress-total';
    total.textContent = `${batch.total} ${batch.total === 1 ? 'doc' : 'docs'}`;

    line.append(name, rings, total);
    return line;
  }
}

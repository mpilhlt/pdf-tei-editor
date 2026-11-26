/**
 * Builds the version options of the selected document, shared by the "Target XML" selectbox of the
 * file-selection plugin and the "Compare with version" selectbox of the merge-view plugin, so that
 * both list the same versions.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect } from '../ui.js'
 * @import { DocumentItem, Artifact, VersionLineage } from './file-data-utils.js'
 */

import { SlOption, SlDivider } from '../ui.js'
import { groupVersionsByLineage, documentHasPdf } from './file-data-utils.js'
import { getArchivedCollectionIds } from './collection-utils.js'

/**
 * Returns a copy of the file data, filtered by the collection filter (or, without one, without the
 * collections that belong only to archived projects) and by the model variant of the state.
 * @param {ApplicationState} state
 * @returns {DocumentItem[]}
 */
export function filterFileData(state) {
  /** @type {DocumentItem[]} */
  const fileData = JSON.parse(JSON.stringify(state.fileData || []));
  let filtered = fileData;
  const collectionFilter = state.collectionFilter;

  if (collectionFilter && collectionFilter !== "") {
    filtered = fileData.filter(file =>
      file.collections && file.collections.includes(collectionFilter)
    ).map(file => { file.collections = [collectionFilter]; return file; });
  } else {
    // Hide collections that belong only to archived projects
    const archivedCollectionIds = getArchivedCollectionIds(state.projects || []);
    if (archivedCollectionIds.size > 0) {
      filtered = fileData.filter(file => {
        if (!file.collections || file.collections.length === 0) return true;
        file.collections = file.collections.filter(c => !archivedCollectionIds.has(c));
        return file.collections.length > 0;
      });
    }
  }

  const variant = state.variant;
  if (variant === "none") {
    filtered = filtered.filter(file => !(file.artifacts && file.artifacts.some(a => !!a.variant)));
  } else if (variant && variant !== "") {
    filtered = filtered.filter(file => file.artifacts && file.artifacts.some(a => a.variant === variant));
  }
  return filtered;
}

/**
 * Returns the identifier under which a file is listed in the "Source File" selectbox: its source,
 * or, for a document without a source, its first artifact.
 * @param {DocumentItem} file
 * @returns {string|null}
 */
export function getFileIdentifier(file) {
  if (file.source) return file.source.id;
  if (file.artifacts && file.artifacts.length > 0) return file.artifacts[0].id;
  return null;
}

/**
 * Whether the file is the document selected in the state: one of its PDFs is the selected PDF, or
 * a non-PDF source that is the selected XML.
 * @param {DocumentItem} file
 * @param {ApplicationState} state
 * @returns {boolean}
 */
export function isSelectedFile(file, state) {
  const fileIdentifier = getFileIdentifier(file);
  if (!fileIdentifier) return false;
  return documentHasPdf(file, state.pdf) ||
    Boolean(file.source && file.source.file_type !== 'pdf' && fileIdentifier === state.xml);
}

/**
 * Returns the versions of the selected document that are listed, filtered by the model variant.
 * Empty if no document is selected or the selected document is filtered out.
 * @param {DocumentItem[]} filteredFileData - The result of {@link filterFileData}
 * @param {ApplicationState} state
 * @returns {Artifact[]}
 */
export function getSelectedFileVersions(filteredFileData, state) {
  const file = filteredFileData.find(f => isSelectedFile(f, state));
  if (!file?.artifacts) return [];
  const variant = state.variant;
  if (variant === "none") return file.artifacts.filter(a => !a.variant);
  if (variant && variant !== "") return file.artifacts.filter(a => a.variant === variant);
  return file.artifacts;
}

/**
 * @param {string} label
 * @param {boolean} [isLocked]
 * @param {string} [variantId]
 * @param {boolean} [isGold] - Prefix the label with a medal marking the gold version
 * @returns {string}
 */
function createDocumentLabel(label, isLocked, variantId, isGold) {
  let html = variantId ? `${label} [${variantId}]` : label;
  if (isGold === true) html = `<sl-icon name="award" slot="prefix" label="Gold version"></sl-icon>${html}`;
  if (isLocked === true) html += `<sl-icon name="file-lock2" slot="suffix"></sl-icon>`;
  return html;
}

/**
 * Appends the options of the given versions to a selectbox: one group per lineage, current versions
 * first, then their superseded (frozen) ancestors, connected to them by lines drawn in CSS (app.css).
 * Ancestors open read-only; they can be compared or copied into a new version. The gold version is
 * marked with a medal inside its lineage, whose group comes first.
 * @param {SlSelect} select
 * @param {Artifact[]} versions - The result of {@link getSelectedFileVersions}
 * @param {string|null|undefined} variant - The model variant filter of the state; without one, the
 *   options show the variant of each version
 */
export function appendVersionOptions(select, versions, variant) {
  /**
   * @param {Artifact} version
   * @param {string[]} [classes] - CSS classes of the option
   */
  const createOption = (version, classes = []) => {
    const variantSuffix = (!variant || variant === "") ? version.variant : undefined;
    const opt = new SlOption();
    // @ts-ignore
    opt.size = "small";
    opt.value = version.id;
    opt.innerHTML = createDocumentLabel(version.label, version.is_locked, variantSuffix, version.is_gold_standard);
    opt.classList.add(...classes);
    if (version.is_gold_standard) opt.dataset.gold = "true";
    return opt;
  };

  const lineages = groupVersionsByLineage(versions);
  const hasGold = (/** @type {VersionLineage} */ g) =>
    g.leaves.concat(g.ancestors).some(v => v.is_gold_standard) ? 0 : 1;
  lineages.sort((a, b) => hasGold(a) - hasGold(b));
  lineages.forEach((group, index) => {
    if (index > 0) select.appendChild(new SlDivider());
    group.leaves.forEach(version => select.appendChild(createOption(version)));
    if (group.leaves.length > 0 && group.ancestors.length > 0) {
      const arrow = document.createElement("div");
      arrow.className = "lineage-arrow";
      arrow.setAttribute("aria-hidden", "true");
      select.appendChild(arrow);
    }
    group.ancestors.forEach((version, i) => {
      const classes = ["lineage-ancestor"];
      if (i === group.ancestors.length - 1) classes.push("lineage-ancestor-last");
      select.appendChild(createOption(version, classes));
    });
  });
}

/**
 * TEI Annotator frontend extension.
 *
 * Adds a "TEI Annotator" submenu to the Tools menu. Each sub-item corresponds to
 * a registered annotator. Sub-items are enabled only when a <bibl> element is
 * selected in the XML editor (state.xpath points to a bibl element).
 */

/**
 * @import { FrontendExtensionSandbox } from '../../../../app/src/modules/frontend-extension-sandbox.js'
 * @import { ApplicationState } from '../../../../app/src/state.js'
 */


export const name = "tei-annotator";
export const deps = ["tools", "xmleditor"];

/**
 * Map of annotator id → sl-menu-item element, populated during start.
 * @type {Record<string, HTMLElement>}
 */
let menuItems = {};

/**
 * Annotator metadata fetched from the backend, stored for use in start().
 * @type {Array<{id: string, display_name: string, description: string}>|null}
 */
let _annotators = null;

/**
 * @param {ApplicationState} _state
 * @param {FrontendExtensionSandbox} sandbox
 */
export async function install(_state, sandbox) {
  // Fetch annotator list during install (before the toolbar exists).
  // Menu items are created in start() once the toolbar is ready.
  try {
    _annotators = await sandbox.callPluginApi('/api/plugins/tei-annotator/annotators', 'GET');
  } catch (err) {
    console.warn('tei-annotator: could not load annotators from backend:', err.message);
  }
}

/**
 * @param {FrontendExtensionSandbox} sandbox
 */
export async function start(sandbox) {
  if (!_annotators || _annotators.length === 0) {
    return;
  }

  // Build parent menu item with nested submenu.
  // Must run in start() — toolsGroup is only added to the DOM during tools.start().
  const parentItem = document.createElement('sl-menu-item');
  parentItem.textContent = 'TEI Annotator';

  const submenu = document.createElement('sl-menu');
  submenu.slot = 'submenu';

  for (const ann of _annotators) {
    const item = document.createElement('sl-menu-item');
    item.textContent = ann.display_name;
    item.title = ann.description;
    item.disabled = true;
    item.addEventListener('click', () => _runAnnotator(ann, sandbox));
    menuItems[ann.id] = item;
    submenu.appendChild(item);
  }

  parentItem.appendChild(submenu);

  const toolsApi = sandbox.getDependency('tools');
  toolsApi.addMenuItems([parentItem], 'annotation');
}

/**
 * @param {string[]} changedKeys
 * @param {ApplicationState} state
 * @param {FrontendExtensionSandbox} _sandbox
 */
export function onStateUpdate(changedKeys, state, _sandbox) {
  if (!changedKeys.includes('xpath')) return;
  const enabled = _isBiblXpath(state.xpath);
  for (const item of Object.values(menuItems)) {
    item.disabled = !enabled;
  }
}

/**
 * @param {{id: string, display_name: string}} ann
 * @param {FrontendExtensionSandbox} sandbox
 */
async function _runAnnotator(ann, sandbox) {
  const state = sandbox.getState();

  if (!_isBiblXpath(state.xpath)) {
    sandbox.notify(
      `Please select a <bibl> element to use the ${ann.display_name}.`,
      'warning',
      'exclamation-triangle'
    );
    return;
  }

  if (!state.xml) {
    sandbox.notify('No document open.', 'warning', 'exclamation-triangle');
    return;
  }

  const xmleditorApi = sandbox.getDependency('xmleditor');
  sandbox.ui.spinner.show(`${ann.display_name}: annotating…`);
  try {
    const { fragments } = await sandbox.callPluginApi(
      '/api/plugins/tei-annotator/annotate',
      'POST',
      { stable_id: state.xml, xpath: state.xpath, annotator_id: ann.id }
    );
    let modifiedXml = _substituteAtXpath(xmleditorApi, state.xpath, fragments);
    if (await sandbox.config.get('xml.encode-entities.server', false)) {
      const encodeQuotes = await sandbox.config.get('xml.encode-quotes', false);
      modifiedXml = sandbox.teiUtils.encodeXmlEntities(modifiedXml, { encodeQuotes });
    }
    await xmleditorApi.showMergeView(modifiedXml);
  } catch (err) {
    sandbox.notify(
      `Annotation failed: ${err.message}`,
      'danger',
      'exclamation-octagon'
    );
  } finally {
    sandbox.ui.spinner.hide();
  }
}

/**
 * Return true when *xpath* ends with a bibl element step.
 * Matches patterns like: tei:bibl, tei:bibl[3], bibl, bibl[1]
 * @param {string|null|undefined} xpath
 * @returns {boolean}
 */
function _isBiblXpath(xpath) {
  if (!xpath) return false;
  return /(?:^|[/\]])(?:tei:)?bibl(?:\[|$)/.test(xpath);
}

const _TEI_NS = 'http://www.tei-c.org/ns/1.0';

/**
 * Clone the editor's parsed XML tree, replace the element at *xpath* with
 * *fragments*, and return the serialized result. The editor document is not
 * modified.
 *
 * @param {import('../../../app/src/plugins/xmleditor.js').XmlEditorApi} xmleditorApi
 * @param {string} xpath - XPath of the element to replace (may use tei: prefix)
 * @param {string[]} fragments - Serialized replacement elements from the backend
 * @returns {string} Modified document XML
 */
function _substituteAtXpath(xmleditorApi, xpath, fragments) {
  const liveDoc = xmleditorApi.getXmlTree();
  if (!liveDoc) {
    throw new Error('No parsed XML tree available in the editor');
  }

  // Clone to avoid modifying the live editor tree
  const doc = /** @type {Document} */ (liveDoc.cloneNode(true));

  /** @param {string} prefix */
  const nsResolver = (prefix) => prefix === 'tei' ? _TEI_NS : null;

  const xpathResult = doc.evaluate(
    xpath, doc, nsResolver, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  );
  const element = xpathResult.singleNodeValue;
  if (!element) {
    throw new Error(`Element not found at XPath: ${xpath}`);
  }

  const parent = element.parentNode;

  // Parse each fragment inside a TEI-namespace wrapper so element names resolve correctly
  for (const fragXml of fragments) {
    const wrapper = new DOMParser().parseFromString(
      `<w xmlns="${_TEI_NS}">${fragXml}</w>`, 'text/xml'
    );
    for (const child of Array.from(wrapper.documentElement.childNodes)) {
      parent.insertBefore(doc.importNode(child, true), element);
    }
  }
  parent.removeChild(element);

  return new XMLSerializer().serializeToString(doc);
}

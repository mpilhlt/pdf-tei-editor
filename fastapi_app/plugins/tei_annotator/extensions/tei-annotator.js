/**
 * TEI Annotator frontend extension.
 *
 * Adds a "TEI Annotator" submenu to the Tools menu. Each sub-item corresponds to
 * a registered annotator. Sub-items are enabled only when a <bibl> element is
 * selected in the XML editor (state.xpath points to a bibl element).
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

const _TEI_NS = 'http://www.tei-c.org/ns/1.0';

export default class TeiAnnotatorExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'tei-annotator', deps: ['tools', 'xmleditor'] });
  }

  /**
   * Annotator metadata fetched from the backend, stored for use in start().
   * @type {Array<{id: string, display_name: string, description: string}>|null}
   */
  _annotators = null;

  /**
   * Map of annotator id → sl-menu-item element, populated during start.
   * @type {Record<string, HTMLElement>}
   */
  _menuItems = {};

  async install(state) {
    await super.install(state);
    try {
      this._annotators = await this.callPluginApi('/api/plugins/tei-annotator/annotators', 'GET');
    } catch (err) {
      console.warn('tei-annotator: could not load annotators from backend:', err.message);
    }
  }

  async start() {
    if (!this._annotators || this._annotators.length === 0) return;

    const parentItem = document.createElement('sl-menu-item');
    parentItem.textContent = 'TEI Annotator';

    const submenu = document.createElement('sl-menu');
    submenu.slot = 'submenu';

    for (const ann of this._annotators) {
      const item = document.createElement('sl-menu-item');
      item.textContent = ann.display_name;
      item.title = ann.description;
      item.disabled = true;
      item.addEventListener('click', () => this._runAnnotator(ann));
      this._menuItems[ann.id] = item;
      submenu.appendChild(item);
    }

    parentItem.appendChild(submenu);
    this.getDependency('tools').addMenuItems([parentItem], 'annotation');
  }

  async onXpathChange(newXpath) {
    const enabled = _isBiblXpath(newXpath);
    for (const item of Object.values(this._menuItems)) {
      item.disabled = !enabled;
    }
  }

  /**
   * @param {{id: string, display_name: string}} ann
   */
  async _runAnnotator(ann) {
    const { xpath, xml } = this.state;

    if (!_isBiblXpath(xpath)) {
      this.getDependency('sl-utils').notify(
        `Please select a <bibl> element to use the ${ann.display_name}.`,
        'warning',
        'exclamation-triangle'
      );
      return;
    }

    if (!xml) {
      this.getDependency('sl-utils').notify('No document open.', 'warning', 'exclamation-triangle');
      return;
    }

    const xmleditorApi = this.getDependency('xmleditor');
    this.getDependency('ui').spinner.show(`${ann.display_name}: annotating…`);
    try {
      const { fragments } = await this.callPluginApi(
        '/api/plugins/tei-annotator/annotate',
        'POST',
        { stable_id: xml, xpath, annotator_id: ann.id }
      );
      let modifiedXml = _substituteAtXpath(xmleditorApi, xpath, fragments);
      if (await this.getDependency('config').get('xml.encode-entities.server', false)) {
        const encodeQuotes = await this.getDependency('config').get('xml.encode-quotes', false);
        modifiedXml = this.getDependency('tei-utils').encodeXmlEntities(modifiedXml, { encodeQuotes });
      }
      await xmleditorApi.showMergeView(modifiedXml);
    } catch (err) {
      this.getDependency('sl-utils').notify(
        `Annotation failed: ${err.message}`,
        'danger',
        'exclamation-octagon'
      );
    } finally {
      this.getDependency('ui').spinner.hide();
    }
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

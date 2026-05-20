/**
 * TEI Annotator frontend extension.
 *
 * Adds a "TEI Annotator" submenu to the Tools menu and contributes the same
 * commands to the XML editor right-click context menu.
 *
 * Items are enabled when a <bibl> element is selected (state.xpath) AND the
 * annotator's target_variants (if set) includes the current variant.
 * The same condition applies to both the Tools menu and the context menu.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

const _TEI_NS = 'http://www.tei-c.org/ns/1.0';

export default class TeiAnnotatorExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'tei-annotator', deps: ['tools', 'xmleditor'] });
  }

  /**
   * Annotator metadata fetched from the backend, including optional target_variants.
   * @type {Array<{id: string, display_name: string, description: string, target_variants: string[]|null}>|null}
   */
  _annotators = null;

  /**
   * The "TEI Annotator" parent sl-menu-item in the Tools submenu, stored so its
   * visibility can be toggled when no annotator applies to the current variant.
   * @type {HTMLElement|null}
   */
  _toolsParentItem = null;

  /**
   * Map of annotator id → sl-menu-item in the Tools submenu.
   * @type {Record<string, HTMLElement>}
   */
  _menuItems = {};

  /**
   * Map of annotator id → sl-menu-item in the right-click context menu.
   * @type {Record<string, HTMLElement>}
   */
  _contextMenuItems = {};

  async install(state) {
    await super.install(state);
  }

  async start() {
    try {
      this._annotators = await this.callPluginApi('/api/plugins/tei-annotator/annotators', 'GET');
    } catch (err) {
      console.warn('tei-annotator: could not load annotators from backend:', err.message);
      return;
    }
    if (!this._annotators || this._annotators.length === 0) return;

    // Tools menu
    const parentItem = document.createElement('sl-menu-item');
    parentItem.textContent = 'TEI Annotator';
    this._toolsParentItem = parentItem;

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

    // Context menu — push items directly since xmleditor is already started
    const xmleditor = this.getDependency('xmleditor');
    for (const ann of this._annotators) {
      const item = document.createElement('sl-menu-item');
      item.textContent = ann.display_name;
      item.title = ann.description;
      item.disabled = true;
      item.addEventListener('click', () => this._runAnnotator(ann));
      this._contextMenuItems[ann.id] = item;
      xmleditor.addContextMenuItem(item, 'annotation');
    }
  }

  async onXpathChange(newXpath) {
    const isBibl = _isBiblXpath(newXpath);
    for (const [id, item] of Object.entries(this._menuItems)) {
      item.disabled = !(isBibl && this._variantAllowed(id));
    }
    for (const [id, item] of Object.entries(this._contextMenuItems)) {
      item.disabled = !(isBibl && this._variantAllowed(id));
    }
  }

  async onVariantChange(newVariant) {
    for (const [id, item] of Object.entries(this._menuItems)) {
      item.style.display = this._variantAllowed(id, newVariant) ? '' : 'none';
    }
    for (const [id, item] of Object.entries(this._contextMenuItems)) {
      item.style.display = this._variantAllowed(id, newVariant) ? '' : 'none';
    }
    // Hide the Tools parent item when no annotator applies to this variant
    if (this._toolsParentItem) {
      const anyVisible = this._annotators?.some(ann => this._variantAllowed(ann.id, newVariant)) ?? false;
      this._toolsParentItem.style.display = anyVisible ? '' : 'none';
    }
    await this.onXpathChange(this.state?.xpath ?? null);
  }

  /**
   * Returns true when the given annotator applies to the current (or given) variant.
   * An annotator with target_variants === null applies to all variants.
   * @param {string} annotatorId
   * @param {string|null} [variant]
   * @returns {boolean}
   */
  _variantAllowed(annotatorId, variant) {
    const v = variant ?? this.state?.variant ?? null;
    const ann = this._annotators?.find(a => a.id === annotatorId);
    if (!ann || !ann.target_variants) return true;
    return v !== null && ann.target_variants.includes(v);
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
      if (modifiedXml === xmleditorApi.getEditorContent()) {
        this.getDependency('sl-utils').notify(
          `${ann.display_name}: no annotations added.`,
          'primary',
          'info-circle'
        );
        return;
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
 * Return the indentation whitespace that precedes *element* in the document.
 *
 * Looks at the immediately preceding sibling. If it is a text node containing
 * a newline, returns the characters after the last newline (the indentation
 * prefix). Returns an empty string when no indentation can be determined.
 *
 * @param {Element} element
 * @returns {string}
 */
export function getIndentation(element) {
  const prev = element.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE) {
    const text = prev.textContent ?? '';
    const idx = text.lastIndexOf('\n');
    if (idx !== -1) return text.slice(idx + 1);
  }
  return '';
}

/**
 * Normalise newlines inside an XML fragment string to match a given indentation.
 *
 * Every `\n` that is **not** at position 0 of *fragXml* is replaced with
 * `\n` + *indent*, so that sibling elements within the fragment align with the
 * surrounding document. A leading newline (position 0) is left untouched
 * because it belongs to the whitespace text node that precedes the fragment,
 * not to the fragment's internal structure.
 *
 * @param {string} fragXml - Serialised XML fragment from the backend
 * @param {string} indent - Whitespace string to insert after each inner newline
 * @returns {string}
 */
export function adjustFragmentIndentation(fragXml, indent) {
  // Strip leading newline — the preceding indentation whitespace already contains one
  const stripped = fragXml.startsWith('\n') ? fragXml.slice(1) : fragXml;
  if (!indent) return stripped;
  return stripped.replace(/\n/g, '\n' + indent);
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
  const indent = getIndentation(element);

  for (const fragXml of fragments) {
    const adjusted = adjustFragmentIndentation(fragXml, indent);
    const wrapper = new DOMParser().parseFromString(
      `<w xmlns="${_TEI_NS}">${adjusted}</w>`, 'text/xml'
    );
    for (const child of Array.from(wrapper.documentElement.childNodes)) {
      parent.insertBefore(doc.importNode(child, true), element);
    }
  }
  parent.removeChild(element);

  return new XMLSerializer().serializeToString(doc);
}

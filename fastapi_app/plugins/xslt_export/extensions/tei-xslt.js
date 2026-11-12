/**
 * @file Frontend Extension: TEI XSLT Viewer
 * Registers XSLT stylesheets for viewing TEI document transformations.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class TeiXsltExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'tei-xslt-viewer', deps: ['xsl-viewer'] });
  }

  static extensionPoints = ['tei-xslt-viewer.export_formats'];

  /**
   * @returns {Array<{id: string, label: string, url: string, output: string, stripTags: boolean, ext: string}>}
   */
  export_formats() {
    return [
      {
        id: 'csv',
        label: 'CSV (biblstruct)',
        url: '/api/plugins/xslt_export/static/biblstruct-to-csv.xslt',
        output: 'html',
        stripTags: true,
        ext: 'csv'
      },
      {
        id: 'ris',
        label: 'RIS (biblstruct)',
        url: '/api/plugins/xslt_export/static/biblstruct-to-ris.xslt',
        output: 'html',
        stripTags: true,
        ext: 'ris'
      },
      {
        id: 'crossref',
        label: 'CrossRef XML',
        url: '/api/plugins/xslt_export/static/tei-to-crossref.xslt',
        output: 'xml',
        stripTags: false,
        ext: 'xml'
      }
    ];
  }

  async start() {
    const TEI_NAMESPACE = 'http://www.tei-c.org/ns/1.0';
    // The stylesheets render the bibliographic references, so they are only offered for
    // documents that contain biblStruct elements, whatever their variant
    const HAS_BIBLSTRUCT = 'boolean(//tei:biblStruct)';
    const transformations = [
      { label: 'Reference list', url: '/api/plugins/xslt-export/static/biblstruct-to-html.xslt',   appliesTo: HAS_BIBLSTRUCT },
      { label: 'Tabular data',   url: '/api/plugins/xslt-export/static/biblstruct-to-table.xslt',  appliesTo: HAS_BIBLSTRUCT },
      { label: 'CSV',            url: '/api/plugins/xslt-export/static/biblstruct-to-csv.xslt',    appliesTo: HAS_BIBLSTRUCT },
      { label: 'RIS',            url: '/api/plugins/xslt-export/static/biblstruct-to-ris.xslt',    appliesTo: HAS_BIBLSTRUCT },
      { label: 'CrossRef XML',   url: '/api/plugins/xslt-export/static/tei-to-crossref-html.xslt', appliesTo: HAS_BIBLSTRUCT }
    ];

    try {
      for (const t of transformations) {
        const xsltString = await this.fetchText(t.url);
        const parser = new DOMParser();
        const xslDoc = parser.parseFromString(xsltString, 'application/xml');

        const parseError = xslDoc.querySelector('parsererror');
        if (parseError) {
          console.error(`tei-xslt: parse error in ${t.url}:`, parseError.textContent);
          return;
        }

        const xslViewer = this.getDependency('xsl-viewer');
        xslViewer.register({
          label: t.label,
          xmlns: TEI_NAMESPACE,
          xslDoc,
          appliesTo: t.appliesTo
        });
      }
    } catch (error) {
      console.error('tei-xslt: Failed to initialize TEI XSLT viewer:', error);
    }
  }
}

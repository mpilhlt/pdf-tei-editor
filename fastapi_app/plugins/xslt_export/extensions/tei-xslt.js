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
    const transformations = [
      { label: 'Reference list', url: '/api/plugins/xslt-export/static/biblstruct-to-html.xslt' },
      { label: 'Tabular data',   url: '/api/plugins/xslt-export/static/biblstruct-to-table.xslt' },
      { label: 'CSV',            url: '/api/plugins/xslt-export/static/biblstruct-to-csv.xslt' },
      { label: 'RIS',            url: '/api/plugins/xslt-export/static/biblstruct-to-ris.xslt' },
      { label: 'CrossRef XML',   url: '/api/plugins/xslt-export/static/tei-to-crossref-html.xslt' }
    ];

    try {
      for (const t of transformations) {
        const xsltString = await this.fetchText(t.url);
        const parser = new DOMParser();
        const xslDoc = parser.parseFromString(xsltString, 'application/xml');

        const parseError = xslDoc.querySelector('parsererror');
        if (parseError) {
          console.error('TEI XSLT parse error:', parseError.textContent);
          return;
        }

        this.getDependency('xsl-viewer').register({
          label: t.label,
          xmlns: TEI_NAMESPACE,
          xslDoc
        });
      }
    } catch (error) {
      console.error('Failed to initialize TEI XSLT viewer:', error);
    }
  }
}

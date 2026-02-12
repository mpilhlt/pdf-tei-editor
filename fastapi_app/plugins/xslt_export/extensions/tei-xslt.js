/**
 * @file Frontend Extension: TEI XSLT Viewer
 * Registers XSLT stylesheets for viewing TEI document transformations.
 */

export const name = "tei-xslt-viewer";
export const description = "Provides XSLT transformations for TEI documents";
export const deps = ['xsl-viewer'];

// Export endpoint functions directly on the extension object
// These will be exposed to the plugin manager's endpoint system
export const export_formats = () => [
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

const TEI_NAMESPACE = "http://www.tei-c.org/ns/1.0";

/**
 * Parse XSLT string to document
 * @param {string} xsltString
 * @returns {Document}
 */
function parseXslt(xsltString) {
  const parser = new DOMParser();
  return parser.parseFromString(xsltString, 'application/xml');
}

/**
 * Called after all plugins are installed.
 * @param {Object} sandbox
 */
export async function start(sandbox) {
  try {
    const transformations = [
      {
        label: 'Reference list',
        url: '/api/plugins/xslt-export/static/biblstruct-to-html.xslt'
      },
      {
        label: 'Tabular data',
        url: '/api/plugins/xslt-export/static/biblstruct-to-table.xslt'
      },
      {
        label: 'CSV',
        url: '/api/plugins/xslt-export/static/biblstruct-to-csv.xslt'
      },
      {
        label: 'RIS',
        url: '/api/plugins/xslt-export/static/biblstruct-to-ris.xslt'
      },
      {
        label: 'CrossRef XML',
        url: '/api/plugins/xslt-export/static/tei-to-crossref-html.xslt'
      }
    ]

    for (let t of transformations ) {
      // Fetch XSLT from xslt-export plugin static files
      const xsltString = await sandbox.fetchText(t.url);
      const xslDoc = parseXslt(xsltString);

      // Check for parse errors
      const parseError = xslDoc.querySelector('parsererror');
      if (parseError) {
        console.error('TEI XSLT parse error:', parseError.textContent);
        return;
      }

      // Register with xsl-viewer
      sandbox.registerXslStylesheet({
        label: t.label,
        xmlns: TEI_NAMESPACE,
        xslDoc: xslDoc
      });
    }
    

  } catch (error) {
    console.error('Failed to initialize TEI XSLT viewer:', error);
  }
}
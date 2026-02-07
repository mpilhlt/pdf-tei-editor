/**
 * @file Frontend Extension: TEI XSLT Viewer
 * Registers XSLT stylesheets for viewing TEI document transformations.
 */

export const name = "tei-xslt-viewer";
export const description = "Provides XSLT transformations for TEI documents";
export const deps = ['xsl-viewer'];

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
        url: '/api/plugins/grobid/static/biblstruct-to-html.xslt'
      },
      {
        label: 'Tabular data',
        url: '/api/plugins/grobid/static/biblstruct-to-table.xslt'
      },
      {
        label: 'CSV',
        url: '/api/plugins/grobid/static/biblstruct-to-csv.xslt'
      },       
      {
        label: 'RIS',
        url: '/api/plugins/grobid/static/biblstruct-to-ris.xslt'
      }    
    ]

    for (let t of transformations ) {
      // Fetch XSLT from grobid plugin static files
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

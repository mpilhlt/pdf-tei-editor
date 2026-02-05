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
    // Fetch XSLT from grobid plugin static files
    const xsltString = await sandbox.fetchText('/api/plugins/grobid/static/bibl-struct.xslt');

    const xslDoc = parseXslt(xsltString);

    // Check for parse errors
    const parseError = xslDoc.querySelector('parsererror');
    if (parseError) {
      console.error('TEI XSLT parse error:', parseError.textContent);
      return;
    }

    // Register with xsl-viewer
    sandbox.registerXslStylesheet({
      label: 'Bibliographic References',
      xmlns: TEI_NAMESPACE,
      xslDoc: xslDoc
    });

  } catch (error) {
    console.error('Failed to initialize TEI XSLT viewer:', error);
  }
}

/**
 * @file Frontend Extension: TEI XSLT Viewer
 * Registers XSLT stylesheets for viewing TEI document transformations.
 */

export const name = "tei-xslt-viewer";
export const description = "Provides XSLT transformations for TEI documents";
export const deps = ['xsl-viewer'];

const TEI_NAMESPACE = "http://www.tei-c.org/ns/1.0";

/**
 * Called during plugin installation phase.
 * @param {Object} state - Initial application state
 * @param {Object} sandbox
 */
export function install(state, sandbox) {
  console.log('DEBUG tei-xslt extension install() called');
}

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
  console.log('DEBUG tei-xslt extension start() called');
  try {
    // Fetch XSLT from grobid plugin route
    console.log('DEBUG tei-xslt: fetching XSLT...');
    const xsltString = await sandbox.fetchText('/api/plugins/grobid/xslt/bibl-struct');
    console.log('DEBUG tei-xslt: fetched XSLT, length:', xsltString?.length);

    const xslDoc = parseXslt(xsltString);
    console.log('DEBUG tei-xslt: parsed XSLT, documentElement:', xslDoc?.documentElement?.tagName);

    // Check for parse errors
    const parseError = xslDoc.querySelector('parsererror');
    if (parseError) {
      console.error('TEI XSLT parse error:', parseError.textContent);
      return;
    }

    // Register with xsl-viewer
    console.log('DEBUG tei-xslt: calling sandbox.registerXslStylesheet()');
    sandbox.registerXslStylesheet({
      label: 'Bibliographic References',
      xmlns: TEI_NAMESPACE,
      xslDoc: xslDoc
    });

    console.log('DEBUG TEI XSLT viewer extension initialized successfully');

  } catch (error) {
    console.error('DEBUG Failed to initialize TEI XSLT viewer:', error);
  }
}

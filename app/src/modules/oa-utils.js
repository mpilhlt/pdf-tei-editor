// Map of license regex patterns to canonical URLs
const licensePatterns = new Map([
  [/^CC0$/i, 'https://creativecommons.org/publicdomain/zero/1.0/'],
  [/^CC BY/i, 'https://creativecommons.org/licenses/by/4.0/'],
  [/^CC BY-SA/i, 'https://creativecommons.org/licenses/by-sa/4.0/'],
  [/^CC BY-ND/i, 'https://creativecommons.org/licenses/by-nd/4.0/'],
  [/^CC BY-NC/i, 'https://creativecommons.org/licenses/by-nc/4.0/'],
  [/^CC BY-NC-SA/i, 'https://creativecommons.org/licenses/by-nc-sa/4.0/'],
  [/^CC BY-NC-ND/i, 'https://creativecommons.org/licenses/by-nc-nd/4.0/'],
  [/^CC Public Domain/i, 'https://creativecommons.org/public-domain/'],
  [/^MIT License$/i, 'https://opensource.org/licenses/MIT'],
  [/^BSD/i, 'https://opensource.org/licenses/BSD-3-Clause'],
  [/^Apache License/i, 'https://www.apache.org/licenses/LICENSE-2.0'],
  [/^GNU GPL/i, 'https://www.gnu.org/licenses/gpl-3.0.html'],
  [/^GNU LGPL/i, 'https://www.gnu.org/licenses/lgpl-3.0.html'],
  [/^Mozilla Public License/i, 'https://www.mozilla.org/en-US/MPL/2.0/'],
  [/^Eclipse Public License/i, 'https://www.eclipse.org/legal/epl-2.0/'],
  [/^Artistic License/i, 'https://www.perlfoundation.org/artistic-license-20.html'],
  [/^ISC License/i, 'https://opensource.org/licenses/ISC'],
  [/^Unlicense/i, 'https://unlicense.org/']
]);

/**
 * Returns the canonical license URL for a given text or false if no match found
 * @param {string} text - Text to search for license patterns
 * @returns {string|false} - Canonical URL or false if no match
 */
export function getLicenseUrl(text) {
  if (!text) return false;
  
  for (const [pattern, url] of licensePatterns) {
    if (pattern.test(text)) {
      return url;
    }
  }
  
  return false;
}

/**
 * Adds a license element to the publicationStmt section of a TEI document
 * Uses Unpaywall API to determine the license from DOI
 * @param {Document} teiDoc - The XML DOM Document object
 * @returns {Promise<void>}
 */
export async function addLicenseElement(teiDoc) {
  // Get DOI from the document
  const doiElements = teiDoc.evaluate(
    '//tei:idno[@type="DOI"]',
    teiDoc,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );
  
  if (doiElements.snapshotLength === 0) {
    console.warn('No DOI found in document, skipping license addition');
    return;
  }
  
  const doiElement = doiElements.snapshotItem(0);
  const doi = doiElement.textContent.trim();
  
  // Remove protocol from DOI if present
  const cleanDoi = doi.replace(/^https?:\/\//, '');
  
  // Fetch license information from Unpaywall API
  const apiUrl = `https://api.unpaywall.org/v2/${cleanDoi}?email=pdf-tei-editor@lhlt.mpg.de`;
  
  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Look for OA location with license information
    let licenseUrl = null;
    
    if (data.oa_locations && Array.isArray(data.oa_locations)) {
      for (const location of data.oa_locations) {
        if (location.license) {
          // Try to match against our license patterns
          const matchedUrl = getLicenseUrl(location.license);
          if (matchedUrl) {
            licenseUrl = matchedUrl;
            break;
          }
        }
      }
    }
    
    // If we still haven't found a license, try to extract from the landing page URL
    if (!licenseUrl && data.oa_locations && data.oa_locations.length > 0) {
      const firstLocation = data.oa_locations[0];
      if (firstLocation.url_for_landing_page) {
        // Try to extract license from URL if it contains license information
        const landingPage = firstLocation.url_for_landing_page;
        for (const [pattern, url] of licensePatterns) {
          if (pattern.test(landingPage)) {
            licenseUrl = url;
            break;
          }
        }
      }
    }
    
    // If we found a license URL, add it to the document
    if (licenseUrl) {
      const teiHeader = getTeiHeader(teiDoc);
      const fileDescs = teiHeader.getElementsByTagName('fileDesc');
      
      if (fileDescs.length > 0) {
        const fileDesc = fileDescs[0];
        const publicationStmts = fileDesc.getElementsByTagName('publicationStmt');
        
        let publicationStmt;
        if (publicationStmts.length > 0) {
          publicationStmt = publicationStmts[0];
        } else {
          // Create publicationStmt if it doesn't exist
          publicationStmt = teiDoc.createElementNS(teiNamespaceURI, 'publicationStmt');
          fileDesc.appendChild(publicationStmt);
        }
        
        // Create and add the licence element
        const licenceElement = teiDoc.createElementNS(teiNamespaceURI, 'licence');
        licenceElement.setAttribute('target', licenseUrl);
        publicationStmt.appendChild(licenceElement);
      }
    }
  } catch (error) {
    console.error('Error fetching license information:', error);
    throw new Error(`Failed to fetch license information for DOI ${doi}: ${error.message}`);
  }
}

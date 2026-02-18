/**
 * @file Enhancement: Split the selected `bibl` element on the semicolon character.
 *
 * ## Testing Notes
 *
 * JSDOM has limited XPath support, particularly for namespace resolvers. When testing
 * enhancements that use XPath with namespace prefixes (e.g., `tei:bibl`), the namespace
 * resolver function may not work correctly in JSDOM.
 *
 * **Solution:** Export a helper function that accepts the target element directly,
 * bypassing XPath resolution. Tests can use DOM methods like `getElementsByTagNameNS()`
 * to get elements and pass them directly to the helper function.
 *
 * Example:
 * ```javascript
 * // In the enhancement module:
 * export function execute(xmlDoc, currentState, configMap) {
 *   const targetNode = xmlDoc.evaluate(xpath, ...); // Uses XPath
 *   processElement(targetNode, xmlDoc);
 * }
 *
 * export function processElement(element, xmlDoc) {
 *   // Core logic, testable without XPath
 * }
 *
 * // In tests:
 * import { processElement } from './enhancement.js';
 * const bibl = xmlDoc.getElementsByTagNameNS(TEI_NS, 'bibl')[0];
 * processElement(bibl, xmlDoc); // Direct element reference, no XPath needed
 * ```
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Split <bibl> on semicolon";

/**
 * Description shown in the UI
 */
export const description = "Split the selected bibl element on the semicolon character.";

const TEI_NS = "http://www.tei-c.org/ns/1.0";

/**
 * @import { ApplicationState } from '/app/src/state.js'; 
 */

/**
 * Splits the selected bibl element on semicolons.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {ApplicationState} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map (unused)
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  const xpath = currentState?.xpath;
  if (!xpath) {
    console.warn("[split-bibl] No xpath in current state");
    return xmlDoc;
  }

  // remove locator suffix
  const cleanXpath = xpath.replace(/\[\d+\]$/, ""); 

  // Create namespace resolver
  const nsResolver = (prefix) => {
    if (prefix === "tei") return TEI_NS;
    return null;
  };

  // Evaluate the xpath to get the target node(s)
  // Use SNAPSHOT_TYPE to get a static list that can be iterated with a for loop
  // This is safer when modifying the DOM during iteration
  let result;
  try {
    result = xmlDoc.evaluate(
      cleanXpath,
      xmlDoc,
      nsResolver,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
  } catch (e) {
    console.warn(`[split-bibl] Invalid xpath '${xpath}': ${e.message}`);
    return xmlDoc;
  }

  if (result.snapshotLength === 0) {
    console.log(`[split-bibl] No nodes found for xpath '${xpath}'`);
    return xmlDoc;
  }

  for (let i = 0; i < result.snapshotLength; i++) {
    const targetNode = result.snapshotItem(i);
    splitBiblElement(targetNode, xmlDoc);
  }
  return xmlDoc;
}

/**
 * Splits a bibl element on semicolons, creating separate bibl elements for each
 * segment. This function is exported for direct testing without XPath resolution.
 *
 * @param {Element} biblElement - The bibl element to split
 * @param {Document} xmlDoc - The XML DOM Document object (for creating new nodes)
 * @returns {boolean} - True if splitting was successful, false otherwise
 */
export function splitBiblElement(biblElement, xmlDoc) {

  // Check if the target node is a tei:bibl
  const localName = biblElement.localName || biblElement.nodeName.split(":").pop();
  const namespaceURI = biblElement.namespaceURI || 
    (biblElement.nodeName.includes(":") ? TEI_NS : null);
  
  if (localName !== "bibl" || namespaceURI !== TEI_NS) {
    console.warn(`[split-bibl] Target node is not a tei:bibl element`);
    return false;
  }

  // Check if there are any semicolons in the content
  const content = biblElement.textContent || "";
  if (!content.includes(";")) {
    console.warn("[split-bibl] No semicolons found in bibl element");
    return false;
  }

  // Collect all child nodes and split on semicolons
  const segments = extractSegments(biblElement, xmlDoc);

  if (segments.length <= 1) {
    console.warn("[split-bibl] Could not split bibl element");
    return false;
  }

  // Get parent and insert new bibl elements
  const parent = biblElement.parentNode;
  if (!parent) {
    console.warn("[split-bibl] bibl element has no parent");
    return false;
  }

  // Insert new bibl elements after the original
  for (let i = segments.length - 1; i >= 0; i--) {
    const newBibl = xmlDoc.createElementNS(TEI_NS, "bibl");
    for (const node of segments[i]) {
      newBibl.appendChild(node);
    }
    parent.insertBefore(newBibl, biblElement.nextSibling);
  }

  // Remove the original bibl
  parent.removeChild(biblElement);
  
  return true;
}

/**
 * Extracts segments from a bibl element by splitting on semicolons.
 * Handles mixed content (text and elements).
 *
 * @param {Element} biblElement - The bibl element to split
 * @param {Document} xmlDoc - The XML document for creating new nodes
 * @returns {Array<Array<Node>>} - Array of node arrays, one per segment
 */
function extractSegments(biblElement, xmlDoc) {
  const segments = [];
  let currentSegment = [];
  const childNodes = Array.from(biblElement.childNodes);

  // Process each child node
  for (let nodeIndex = 0; nodeIndex < childNodes.length; nodeIndex++) {
    const child = childNodes[nodeIndex];
    
    if (child.nodeType === Node.TEXT_NODE) {
      // Split text node on semicolons
      const textParts = splitTextOnSemicolon(child.textContent || "");
      
      if (textParts.length === 1) {
        // No semicolon split needed for this text node
        const text = textParts[0];
        
        // Check if text ends with semicolon (trailing semicolon with no text after)
        const hasTrailingSemicolon = /;(\s*)$/.test(text);
        
        if (hasTrailingSemicolon && nodeIndex < childNodes.length - 1) {
          // Trailing semicolon with more nodes after - split here
          currentSegment.push(xmlDoc.createTextNode(text));
          segments.push(currentSegment);
          currentSegment = [];
        } else {
          currentSegment.push(child.cloneNode(true));
        }
      } else {
        // Multiple parts - create new text nodes and segment boundaries
        for (let i = 0; i < textParts.length; i++) {
          const newText = xmlDoc.createTextNode(textParts[i]);
          currentSegment.push(newText);
          
          if (i < textParts.length - 1) {
            // This is a segment boundary (after a semicolon)
            segments.push(currentSegment);
            currentSegment = [];
          }
        }
      }
    } else {
      // Non-text node (element, etc.) - add to current segment
      currentSegment.push(child.cloneNode(true));
    }
  }

  // Add the last segment if not empty
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

/**
 * Splits text on semicolons, keeping the semicolon (and optional trailing space)
 * with the first part.
 *
 * @param {string} text - The text to split
 * @returns {string[]} - Array of text segments
 */
function splitTextOnSemicolon(text) {
  const parts = [];
  let currentPos = 0;
  
  // Match semicolon followed by optional space
  const regex = /;(\s)?/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    // Include the semicolon and any trailing space in the first part
    const endPos = match.index + match[0].length;
    parts.push(text.substring(currentPos, endPos));
    currentPos = endPos;
  }
  
  // Add remaining text after last semicolon
  if (currentPos < text.length) {
    parts.push(text.substring(currentPos));
  }
  
  // If no semicolons found, return original text
  if (parts.length === 0) {
    return [text];
  }
  
  return parts;
}
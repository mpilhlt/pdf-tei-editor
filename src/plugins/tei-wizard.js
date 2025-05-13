/**
 * This plugin provides handlers for the "tei.enhancement" endpoint that is invoked with TEI documents or nodes,
 * and returns an enhanced version of the document
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 */

import { api as logger } from './logger.js'
import { api as xmleditor } from './xmleditor.js'

//import { xmlFormat } from 'xml-formatter' // better than custom implementation?


const plugin = {
  name: "tei-wizard",
  install,
  tei: {
    enhancement
  }
}


export { plugin }
export default plugin

/**
 * The current module
 * @type {Object}
 */
let module;

/**
 * @param {ApplicationState} state 
 */
async function install(state) {
  // trick to self-inspect exported functions
  import('./tei-wizard.js').then(m => { module = m })
}

/**
 * Endpoint invoked with a TEI document 
 * @param {Element} teiDoc The TEI document or fragment
 * @returns {Promise<Element>} A modified document with the suggested changes
 */
async function enhancement(teiDoc) {

  // apply all exported functions that start with "tei_" in sequence
  Object.entries(module)
    .filter(([key, val]) => key.startsWith("tei_") && typeof val == "function")
    .forEach(([key, func]) => { teiDoc = func(teiDoc) })

  return teiDoc
}

/**
 * Adds a <change> node with the current date and "Corrections" description
 * to the /TEI/teiHeader/revisionDesc section of an XML DOM document using XPath.
 * The node is only added if the parent path exists and a <change> node
 * with the current date doesn't already exist within revisionDesc.
 * Assumes no namespaces.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @returns {Document} - The modified XML DOM Document object, or the original
 *                       document object if the change was not made (due to
 *                       XPath not found or change already existing).
 */
export function tei_addRevisionChange(xmlDoc) {
  // Keep a reference to the original document in case we need to return it
  const originalXmlDoc = xmlDoc;

  // 1. Get the current date in YYYY-MM-DD format
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
  const day = String(today.getDate()).padStart(2, '0');
  const currentDateString = `${year}-${month}-${day}`;

  console.log(`Attempting to add change for date: ${currentDateString}`);

  // 2. Find the target parent node: /TEI/teiHeader/revisionDesc using XPath
  const xpathExpression = '//tei:revisionDesc';

  let revisionDescElement;
  const xpathResult = xmlDoc.evaluate(
    xpathExpression,
    xmlDoc,
    xmleditor.namespaceResolver,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null
  );
  revisionDescElement = xpathResult.singleNodeValue;

  // Check if the revisionDesc node was found
  if (!revisionDescElement) {
    console.warn(`Target node "${xpathExpression}" not found in the document.`);
    // Return the original document if the target node doesn't exist
    return originalXmlDoc;
  }

  // 3. Check if a <change> node with the current date already exists under revisionDesc
  // @ts-ignore
  const existingChanges = revisionDescElement.getElementsByTagName('change');
  for (let i = 0; i < existingChanges.length; i++) {
    const changeNode = existingChanges[i];
    if (changeNode.getAttribute('when') === currentDateString) {
      return originalXmlDoc;
    }
  }

  // 4. If no existing node with the current date, create and add the new one

  // Create the <change> element
  const teiNamespaceURI = 'http://www.tei-c.org/ns/1.0';
  const newChangeElement = xmlDoc.createElementNS(teiNamespaceURI, 'change');
  newChangeElement.setAttribute('when', currentDateString);
  const descElement = xmlDoc.createElementNS(teiNamespaceURI, 'desc');
  const textNode = xmlDoc.createTextNode('Corrections');
  descElement.appendChild(textNode);
  newChangeElement.appendChild(descElement);
  revisionDescElement.appendChild(newChangeElement);
  return xmlDoc;

}


/**
 * Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 * This modifies the original document object in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {string} [spacing='  '] - The string to use for each level of indentation (e.g., '  ' or '\t').
 * @returns {Document} - The modified XML DOM Document object.
 */
export function tei_prettyPrintXmlDom(xmlDoc, spacing = '  ') {
  if (!xmlDoc || typeof xmlDoc.documentElement === 'undefined') {
    console.error("Invalid XML Document object provided for pretty-printing.");
    return xmlDoc; // Return unchanged if input is invalid
  }

  // Helper function to remove existing pure whitespace text nodes
  // This cleans up any previous formatting or accidental whitespace
  function removeWhitespaceNodes(node) {
    // Iterate over children array because we might remove nodes
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Check if the text node consists only of whitespace characters (spaces, tabs, newlines, etc.)
        if (/^\s*$/.test(child.nodeValue)) {
          node.removeChild(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        removeWhitespaceNodes(child); // Recurse into elements
      }
      // Ignore other node types like comments, processing instructions for removal
    }
  }

  // Helper recursive function to add indentation
  function addIndentation(node, depth, spacing, doc) {
    // Only process Element nodes
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    // Create the indentation string for this depth level
    const indent = '\n' + spacing.repeat(depth);

    // Get a static list of children before we start modifying the list
    const children = Array.from(node.childNodes);

    let lastElementChild = null;
    let firstNonWsChild = null;

    // Find the first non-whitespace child (useful for deciding if to indent *after* the start tag)
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        firstNonWsChild = child;
        break;
      } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim() !== '') {
        firstNonWsChild = child;
        break;
      } else if (child.nodeType === Node.COMMENT_NODE || child.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
        firstNonWsChild = child; // Treat comments/PIs as breaking text flow
        break;
      }
    }


    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        // Add indentation *before* the element child
        // Only if it's the first child element OR if the previous sibling wasn't already a newline
        // Simpler approach: Just always add it if it's an element child. removeWhitespaceNodes cleans up duplicates later if needed, but our adding logic should prevent that.
        node.insertBefore(doc.createTextNode(indent + spacing), child);

        // Recursively indent the child's content
        addIndentation(child, depth + 1, spacing, doc);

        lastElementChild = child; // Keep track of the last element child processed
      }
      // Note: Text, Comment, PI nodes are not processed by this adding loop's main logic
      // They are handled implicitly by where we insert whitespace around elements
    }

    // After iterating through children, if there were any element children,
    // add indentation *before* the closing tag of the current node.
    // This is inserted after the last element child, or where the first non-element child was,
    // or at the end if only elements were children.
    if (lastElementChild !== null) {
      // Insert the closing tag indent *after* the last element child
      // Using insertBefore with null or lastChild.nextSibling appends
      node.insertBefore(doc.createTextNode(indent), lastElementChild.nextSibling);
    }
    // If there were no element children, the node will remain on one line with its text content
    // e.g., <desc>Corrections</desc> - this is standard pretty printing behavior.
  }

  // --- Main pretty-printing logic ---

  // Start by cleaning up any existing mixed whitespace/indentation
  removeWhitespaceNodes(xmlDoc.documentElement);

  const root = xmlDoc.documentElement;
  if (!root) {
    // Should have been caught above, but double check
    return xmlDoc;
  }

  // Add indentation for children of the root element
  // The root itself doesn't get preceding indentation (relative to nothing)
  const rootChildren = Array.from(root.childNodes); // Capture state before modification

  let lastProcessedRootNode = null; // Track the last significant node to decide on the final newline

  for (const child of rootChildren) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      // Add indent before root element children (relative to the root)
      root.insertBefore(xmlDoc.createTextNode('\n' + spacing), child);
      // Recursively indent the child and its descendants
      addIndentation(child, 1, spacing, xmlDoc); // Start recursion at depth 1 for children of root
      lastProcessedRootNode = child;
    } else if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE || child.nodeType === Node.COMMENT_NODE) {
      // Handle <?xml?> and comments at the top level.
      // Ensure they are followed by a newline if the next sibling is an element.
      const nextSibling = child.nextSibling;
      if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
        // Check if there isn't already a text node immediately following that contains a newline
        if (!(nextSibling.previousSibling && nextSibling.previousSibling.nodeType === Node.TEXT_NODE && nextSibling.previousSibling.nodeValue?.includes('\n'))) {
          root.insertBefore(xmlDoc.createTextNode('\n'), nextSibling);
        }
      }
      lastProcessedRootNode = child; // These count as processed for the final newline
    } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim() !== '') {
      // Handle non-whitespace text nodes directly under root (uncommon in TEI, but possible)
      // We don't add indent before or after these typically in simple pretty-printing
      lastProcessedRootNode = child;
    }
    // Pure whitespace text nodes were removed by removeWhitespaceNodes
  }

  // Add a final newline before the root's closing tag IF there was any content
  // (Element, non-whitespace text, PI, or Comment) processed at the root level.
  // Check if the last child of the root after modifications is a text node ending in newline
  let actualLastChild = root.lastChild;
  if (lastProcessedRootNode && !(actualLastChild && actualLastChild.nodeType === Node.TEXT_NODE && actualLastChild.nodeValue?.endsWith('\n'))) {
    root.appendChild(xmlDoc.createTextNode('\n')); // Append newline before </root>
  }


  // Return the document (which has been modified in place)
  return xmlDoc;
}
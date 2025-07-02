/**
 * @file Enhancement: Adds a <change> node with the current date and "Corrections" description
 * to the /TEI/teiHeader/revisionDesc section of an XML DOM document using XPath.
 */
import { api as xmleditor } from '../../xmleditor.js'

/**
 * The node is only added if the parent path exists and a <change> node
 * with the current date doesn't already exist within revisionDesc.
 * Assumes no namespaces.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @returns {Document} - The modified XML DOM Document object, or the original
 *                       document object if the change was not made (due to
 *                       XPath not found or change already existing).
 */
function addRevisionChange(xmlDoc) {
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

export default {
  name: "Add Revision Change",
  description: "Adds a <change> node with the current date to the <revisionDesc> section.",
  execute: addRevisionChange
};

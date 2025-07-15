const teiNamespaceURI = 'http://www.tei-c.org/ns/1.0';

/**
 * Returns the TEI header element or throws an error if not found.
 * @param {Document} xmlDoc The XML DOM Document object.
 * @returns {Element} - The TEI header element
 * @throws {Error} If the TEI header is not found in the document.
 */
function getTeiHeader(xmlDoc) {
  let teiHeader = xmlDoc.getElementsByTagName('teiHeader');
  if (!teiHeader.length) {
    throw new Error("TEI header not found in the document.");
  } else {
    teiHeader = teiHeader[0];
  }
  return teiHeader;
}

/**
 * Add a <change> node to the /TEI/teiHeader/revisionDesc section of an XML DOM document.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {string} [status="draft"] - The status of the change, default is "draft"
 * @param {string} [who] - Optional attribute to specify who made the change.
 * @param {string} [why] - Optional attribute to specify the reason for or description of the change.
 * @returns {Document} - The modified XML DOM Document object.
 */
export function addRevisionChange(xmlDoc, status="draft", who, why) {
  const currentDateString = new Date().toISOString();
  let revisionDescElement = xmlDoc.getElementsByTagName('revisionDesc');
  if (!revisionDescElement.length) {
    const teiHeader = getTeiHeader(xmlDoc);
    revisionDescElement = xmlDoc.createElementNS(teiNamespaceURI, 'revisionDesc');
    teiHeader.appendChild(revisionDescElement);
  } else {
    revisionDescElement = revisionDescElement[0];
  }
  
  // Create the <change> element
  const changeElem = xmlDoc.createElementNS(teiNamespaceURI, 'change');
  changeElem.setAttribute('when', currentDateString);
  changeElem.setAttribute('status', status);

  if (who) { // Conditional check for 'who' parameter
    changeElem.setAttribute('who', who);
  }
  
  if (why) {
    const descElement = xmlDoc.createElementNS(teiNamespaceURI, 'desc');
    const textNode = xmlDoc.createTextNode(why); 
    descElement.appendChild(textNode);
    changeElem.appendChild(descElement);
  }
  
  revisionDescElement.appendChild(changeElem);
  return xmlDoc;
}

/**
 * Add a <edition> node to the /TEI/teiHeader/fileDesc/editionStmt section of an XML DOM document.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {string} [note] - An optional note to include in the edition element.
 * @returns {Document} - The modified XML DOM Document object.
 */
export function addEdition(xmlDoc, note) {
  const currentDateString = new Date().toISOString();
  let editionStmt = xmlDoc.getElementsByTagName('editionStmt');
  if (!editionStmt.length) {
    const teiHeader = getTeiHeader(xmlDoc);
    const fileDesc = teiHeader.getElementsByTagName('fileDesc');
    if (!fileDesc.length) {
      throw new Error("teiHeader/fileDesc not found in the document.");
    }
    editionStmt = xmlDoc.createElementNS(teiNamespaceURI, 'editionStmt');
    fileDesc[0].appendChild(editionStmt);
  } else {
    editionStmt = editionStmt[0];
  }
  
  // Create the <edition> element
  const editionElem = xmlDoc.createElementNS(teiNamespaceURI, 'edition'); // Fixed: creating <edition> element

  // Create and append the <date> element as a child of <edition>
  const dateElem = xmlDoc.createElementNS(teiNamespaceURI, 'date'); // Fixed: creating <date> element
  dateElem.setAttribute('when', currentDateString); // Keeping ISO string as per original code.
  dateElem.textContent = currentDateString;
  editionElem.appendChild(dateElem); // Appending <date> to <edition>

  // add a <note> child if provided and not empty or just whitespace
  if (note && note.trim() !== '') { // Fixed: preventing empty <note> tags
    const noteElem = xmlDoc.createElementNS(teiNamespaceURI, 'note');
    noteElem.textContent = note;
    editionElem.appendChild(noteElem);
  }
  
  editionStmt.appendChild(editionElem); // Appending the complete <edition> element to editionStmt
  return xmlDoc;
}


/**
 * Adds a respStmt element to the titleStmt of a TEI header.
 *
 * @param {Document} xmlDoc The XML DOM Document object.
 * @param {string} persName The name of the person.
 * @param {string} resp The role or responsibility 
 * @param {string} persId  XML ID for the person
 * @returns {Document} The modified XML DOM Document object.
 */
export function addRespStmt(xmlDoc, persName, resp, persId) {
  // Removed validation for persId being mandatory as per bug fix.
  // The original code implied it was mandatory with `!persId` check. If it's truly optional,
  // the logic below needs to handle its absence. Assuming for strict bug fix, it IS required based on original validation.
  // If it should be optional, the function logic would need more changes.
  // For now, keeping the original mandatory check.
  if (!persName || !resp || !persId ) {
    throw new Error("Missing required parameters: persName, resp, or persId.");
  }

  const teiHeader = getTeiHeader(xmlDoc);
  let titleStmt = teiHeader.getElementsByTagName('titleStmt');

  // Fixed: Create titleStmt if it does not exist, instead of throwing an error.
  if (!titleStmt.length) {
    titleStmt = xmlDoc.createElementNS(teiNamespaceURI, 'titleStmt');
    teiHeader.appendChild(titleStmt);
  } else {
    titleStmt = titleStmt[0];
  }

  const respStmtElem = xmlDoc.createElementNS(teiNamespaceURI, 'respStmt');
  const persNameElem = xmlDoc.createElementNS(teiNamespaceURI, 'persName');
  persNameElem.setAttribute('xml:id', persId);
  persNameElem.textContent = persName;
  respStmtElem.appendChild(persNameElem);

  const respElem = xmlDoc.createElementNS(teiNamespaceURI, 'resp');
  respElem.textContent = resp;
  respStmtElem.appendChild(respElem);

  titleStmt.appendChild(respStmtElem);

  return xmlDoc;
}
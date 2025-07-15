import { xml } from "@codemirror/lang-xml";

const teiNamespaceURI = 'http://www.tei-c.org/ns/1.0';
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace'

/**
 * Returns the TEI header element or throws an error if not found.
 * @param {Document} xmlDoc The XML DOM Document object.
 * @returns {Element} - The TEI header element
 * @throws {Error} If the TEI header is not found in the document.
 */
export function getTeiHeader(xmlDoc) {
  let teiHeader = xmlDoc.getElementsByTagName('teiHeader');
  if (!teiHeader.length) {
    throw new Error("TEI header not found in the document.");
  } else {
    teiHeader = teiHeader[0];
  }
  return teiHeader;
}

/**
 * Returns the <respStmt> containing a <persName> with the given xml:id or null if none can be found  
 * @param {Document} xmlDoc 
 * @param {string} id 
 * @returns {Element || null}
 */
export function getRespStmtById(xmlDoc, id) {
  for (const respStmtElem of xmlDoc.getElementsByTagName('respStmt') ) {
    for (const persNameElem of respStmtElem.getElementsByTagName('persName')) {
      const xmlId = persNameElem.getAttributeNodeNS('http://www.w3.org/XML/1998/namespace','id').value 
      if (xmlId === id) {
        return respStmtElem
      }
    }
  }
  return null
}

/**
 * Add a <change> node to the /TEI/teiHeader/revisionDesc section of an XML DOM document.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {string} [status="draft"] - The status of the change, default is "draft"
 * @param {string} [persId] - Optional attribute to specify who made the change.
 * @param {string} [desc] - Optional attribute to specify the reason for or description of the change.
 * @throws {Error} If the TEI header is not found in the document
 * @returns {void}
 */
export function addRevisionChange(xmlDoc, status="draft", persId, desc) {
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

  if (persId) { // Conditional check for 'who' parameter
    changeElem.setAttribute('who', '#' + persId);
  }
  
  if (desc) {
    const descElement = xmlDoc.createElementNS(teiNamespaceURI, 'desc');
    const textNode = xmlDoc.createTextNode(desc); 
    descElement.appendChild(textNode);
    changeElem.appendChild(descElement);
  }
  
  revisionDescElement.appendChild(changeElem);
}

/**
 * Add a <edition> node to the /TEI/teiHeader/fileDesc/editionStmt section of an XML DOM document.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {string} [note] - An optional note to include in the edition element.
 * @throws {Error} If the TEI header or the fileDesc element is not found in the document.
 * @returns {void}
 */
export function addEdition(xmlDoc, note) {
  const date = new Date()
  const currentDateString = date.toISOString();
  let editionStmt = xmlDoc.getElementsByTagName('editionStmt');
  if (!editionStmt.length) {
    const teiHeader = getTeiHeader(xmlDoc);
    const fileDesc = teiHeader.getElementsByTagName('fileDesc');
    const titleStmt = teiHeader.getElementsByTagName('titleStmt');
    if (!fileDesc.length|| !titleStmt.length) {
      throw new Error("teiHeader/fileDesc/titleStmt not found in the document.");
    }
    editionStmt = xmlDoc.createElementNS(teiNamespaceURI, 'editionStmt');
    if (titleStmt[0].nextSibling) {
      fileDesc[0].insertBefore(editionStmt, titleStmt[0].nextSibling);
    } else {
      fileDesc[0].appendChild(editionStmt)
    }
  } else {
    editionStmt = editionStmt[0];
  }
  
  // Create the <edition> element
  const editionElem = xmlDoc.createElementNS(teiNamespaceURI, 'edition'); // Fixed: creating <edition> element

  // Create and append the <date> element as a child of <edition>
  const dateElem = xmlDoc.createElementNS(teiNamespaceURI, 'date'); // Fixed: creating <date> element
  dateElem.setAttribute('when', currentDateString); // Keeping ISO string as per original code.
  dateElem.textContent = date.toLocaleDateString() + " " + date.toLocaleTimeString();
  editionElem.appendChild(dateElem); // Appending <date> to <edition>

  // add a <note> child if provided and not empty or just whitespace
  if (note && note.trim() !== '') { // Fixed: preventing empty <note> tags
    const noteElem = xmlDoc.createElementNS(teiNamespaceURI, 'note');
    noteElem.textContent = note;
    editionElem.appendChild(noteElem);
  }
  
  editionStmt.appendChild(editionElem); // Appending the complete <edition> element to editionStmt
}


/**
 * Adds a respStmt element to the titleStmt of a TEI header.
 *
 * @param {Document} xmlDoc The XML DOM Document object.
 * @param {string} persName The name of the person.
 * @param {string} persId  XML ID for the person
 * @param {string} resp The role or responsibility 
 * @throws {Error} If the TEI header is not found in the document or the persId already exists.
 * @returns {void}
 */
export function addRespStmt(xmlDoc, persName, persId, resp) {
  if (!persName || !resp || !persId ) {
    throw new Error("Missing required parameters: persName, resp, or persId.");
  }
  if (getRespStmtById(xmlDoc, persId)) {
    throw new Error(`Element with xml:id="${persId}" already exists in the document.`);
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
}
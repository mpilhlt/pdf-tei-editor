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
 * Represents a responsibility statement.
 * @typedef {object} RespStmt
 * @property {string} persId - The ID of the person.
 * @property {string} persName - The name of the person 
 * @property {string} resp - The responsibility.
 */

/**
 * Adds a respStmt element to the titleStmt of a TEI header.
 *
 * @param {Document} xmlDoc The XML DOM Document object.
 * @param {RespStmt} respStmt Object containing data for the 'respStmt' element.
 * @throws {Error} If the TEI header is not found in the document or the persId already exists.
 * @returns {void}
 */
export function addRespStmt(xmlDoc, respStmt) {
  const { persName, persId, resp} = respStmt
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


/**
 * Represents a revision change statement.
 * @typedef {object} RevisionChange
 * @property {string} status - The status of the revision.
 * @property {string} persId - The ID of the person making the revision.
 * @property {string} desc - A description of the revision.
 */

/**
 * Add a <change> node to the /TEI/teiHeader/revisionDesc section of an XML DOM document.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {RevisionChange} revisionChange - Object containing data for the 'change' element
 * @throws {Error} If the TEI header is not found in the document
 * @returns {void}
 */
export function addRevisionChange(xmlDoc, revisionChange) {
  const {status="draft", persId, desc} = revisionChange
  if (!persId || ! desc) {
    throw new Error("persId and desc data required")
  }
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
 * Represents an 'edition' statement within a 'editionStmt' element.
 * @typedef {object} Edition
 * @property {string} title - The title of the edition.
 * @property {string} [note] - An optional note about the edition.
 */

/**
 * Add or replace a <edition> node to the /TEI/teiHeader/fileDesc/editionStmt section of an XML DOM document.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @param {Edition} edition - Object containing data for the 'edition' element
 * @throws {Error} If the TEI header or the fileDesc element is not found in the document.
 * @returns {void}
 */
export function addEdition(xmlDoc, edition) {
  const {title, note} = edition
  if (!title || title.trim() === '') {
    throw new Error("Missing 'title'")
  }
  const date = new Date()
  const currentDateString = date.toISOString();
  const teiHeader = getTeiHeader(xmlDoc);
  const fileDescs = teiHeader.getElementsByTagName('fileDesc');
  const titleStmts = teiHeader.getElementsByTagName('titleStmt');
  if (!fileDescs.length|| !titleStmts.length) {
    throw new Error("teiHeader/fileDesc/titleStmt not found in the document.");
  }
  
  const editionStmts = xmlDoc.getElementsByTagName('editionStmt');
  const editionStmt = xmlDoc.createElementNS(teiNamespaceURI, 'editionStmt');
  const fileDesc = fileDescs[0]
  const titleStmt = titleStmts[0]
  
  if (editionStmts.length > 0) {
    const lastEditionStmt = editionStmts[editionStmts.length-1]
    fileDesc.replaceChild(editionStmt, lastEditionStmt)
  } else {
    if (titleStmt.nextSibling) {
      fileDesc.insertBefore(editionStmt, titleStmt.nextSibling);
    } else {
      fileDesc.appendChild(editionStmt)
    }
  } 
  
  // <edition> 
  const editionElem = xmlDoc.createElementNS(teiNamespaceURI, 'edition'); // Fixed: creating <edition> element

  // <date> 
  const dateElem = xmlDoc.createElementNS(teiNamespaceURI, 'date'); // Fixed: creating <date> element
  dateElem.setAttribute('when', currentDateString); // Keeping ISO string as per original code.
  dateElem.textContent = date.toLocaleDateString() + " " + date.toLocaleTimeString();
  editionElem.appendChild(dateElem); // Appending <date> to <edition>

  // <title>  
  const titleElem = xmlDoc.createElementNS(teiNamespaceURI, 'title');
  titleElem.textContent = title;
  editionElem.appendChild(titleElem);
  
  // <note> 
  if (note && note.trim() !== '') { 
    const noteElem = xmlDoc.createElementNS(teiNamespaceURI, 'note');
    noteElem.textContent = note;
    editionElem.appendChild(noteElem);
  }
  
  editionStmt.appendChild(editionElem);
}

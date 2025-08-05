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
  for (const respStmtElem of xmlDoc.getElementsByTagName('respStmt')) {
    for (const persNameElem of respStmtElem.getElementsByTagName('persName')) {
      const xmlId = persNameElem.getAttributeNodeNS('http://www.w3.org/XML/1998/namespace', 'id').value
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
  const { persName, persId, resp } = respStmt
  if (!persName || !resp || !persId) {
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
  const { status = "draft", persId, desc } = revisionChange
  if (!persId || !desc) {
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
  const { title, note } = edition
  if (!title || title.trim() === '') {
    throw new Error("Missing 'title'")
  }
  const date = new Date()
  const currentDateString = date.toISOString();
  const teiHeader = getTeiHeader(xmlDoc);
  const fileDescs = teiHeader.getElementsByTagName('fileDesc');
  const titleStmts = teiHeader.getElementsByTagName('titleStmt');
  if (!fileDescs.length || !titleStmts.length) {
    throw new Error("teiHeader/fileDesc/titleStmt not found in the document.");
  }


  const editionStmt = xmlDoc.createElementNS(teiNamespaceURI, 'editionStmt');
  const fileDesc = fileDescs[0]
  const editionStmts = xmlDoc.getElementsByTagName('editionStmt');
  const titleStmt = titleStmts[0]

  if (editionStmts.length > 0) {
    const lastEditionStmt = editionStmts[editionStmts.length - 1]
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

/**
 * Escapes special XML characters in a string to their corresponding entities.
 * The order of replacements is important to avoid double-escaping.
 * Ampersand (&) must be replaced first.
 *
 * @param {string} unsafeString The raw string that may contain special characters.
 * @returns {string} The string with special characters converted to XML entities.
 */
export function escapeXml(unsafeString) {
  if (typeof unsafeString !== 'string') {
    return '';
  }
  return unsafeString
    .replaceAll(/&/g, '&amp;')
    .replaceAll(/</g, '&lt;')
    .replaceAll(/>/g, '&gt;')
    .replaceAll(/"/g, '&quot;')
    .replaceAll(/'/g, '&apos;');
}

/**
 * Un-escapes common XML/HTML entities in a string back to their original characters.
 * The order is important here as well; ampersand (&) must be last.
 *
 * @param {string} escapedString The string containing XML entities.
 * @returns {string} The string with entities converted back to characters.
 */
export function unescapeXml(escapedString) {
  if (typeof escapedString !== 'string') {
    return '';
  }
  return escapedString
    .replaceAll(/&quot;/g, '"')
    .replaceAll(/&apos;/g, "'")
    .replaceAll(/&lt;/g, '<')
    .replaceAll(/&gt;/g, '>')
    .replaceAll(/&amp;/g, '&');
}

/**
 * Escapes special characters in XML content using a manual string-parsing approach.
 *
 * This function iterates through the string, keeping track of whether the
 * current position is inside a tag or in the content between tags, and
 * only applies escaping to the content portion.
 *
 * @param {string} xmlString The raw XML string to be processed.
 * @returns {string} A new XML string with its node content properly escaped.
 */
export function encodeXmlEntities(xmlString) {
  if (typeof xmlString !== 'string') {
    return "";
  }

  let inTag = false;
  const resultParts = [];
  let contentBuffer = [];

  for (const char of xmlString) {
    if (char === '<') {
      // When a '<' is found, the preceding text in the buffer is content.
      // Un-escape it first to prevent double-escaping, then re-escape it.
      if (contentBuffer.length > 0) {
        const contentToProcess = contentBuffer.join('');
        const unescapedContent = unescapeXml(contentToProcess);
        const escapedContent = escapeXml(unescapedContent);
        resultParts.push(escapedContent);
        contentBuffer = []; // Reset the buffer.
      }

      inTag = true;
      resultParts.push(char);

    } else if (char === '>') {
      // A '>' signifies the end of a tag.
      inTag = false;
      resultParts.push(char);

    } else {
      if (inTag) {
        // Characters inside a tag are appended directly.
        resultParts.push(char);
      } else {
        // Characters outside a tag are content and are buffered.
        contentBuffer.push(char);
      }
    }
  }

  // After the loop, process any final remaining content from the buffer.
  if (contentBuffer.length > 0) {
    const contentToProcess = contentBuffer.join('');
    const unescapedContent = unescapeXml(contentToProcess);
    const escapedContent = escapeXml(unescapedContent);
    resultParts.push(escapedContent);
  }

  return resultParts.join('');
}

/**
 * Creates a CodeMirror autocomplete data structure from a compressed version sent
 * by the server, which uses "#x" references which are reused at different places. This
 * includes "#Mx" references which are macros containing references. Returns the resolved version
 * with the string references replaced by the actual object references.
 * 
 * Code generated by Claude Code with instructions by @cboulanger
 * 
 * @param {Object} data Map to be resolved
 * @returns {Object} Resolved map
 */
export function resolveDeduplicated(data) {
  // Create a copy to avoid modifying the original
  const resolved = JSON.parse(JSON.stringify(data));

  // Extract and resolve reference definitions (keys starting with #)
  const refs = {};
  Object.keys(resolved).forEach(key => {
    if (key.startsWith('#')) {
      refs[key] = resolved[key];
      delete resolved[key];
    }
  });

  // Pre-resolve all references to create shared objects
  const resolvedRefs = {};

  // First pass: resolve simple references and macros
  Object.keys(refs).forEach(refId => {
    if (refId.startsWith('#M')) {
      // Macro reference - resolve to composite pattern
      const macroContent = refs[refId];
      if (typeof macroContent === 'string' && macroContent.includes(' ')) {
        const refIds = macroContent.split(' ').filter(id => id.startsWith('#'));
        resolvedRefs[refId] = mergeReferences(refIds, refs);
      } else {
        resolvedRefs[refId] = refs[refId];
      }
    } else {
      // Simple reference - use as-is (will be shared)
      resolvedRefs[refId] = refs[refId];
    }
  });

  // Recursive function to resolve references using shared objects
  function resolveRefs(obj) {
    if (typeof obj === 'string' && obj.includes('#')) {
      if (obj.startsWith('#') && !obj.includes(' ')) {
        // Simple reference - return shared object and recursively resolve its contents
        const resolved = resolvedRefs[obj];
        if (resolved) {
          return resolveRefs(resolved); // Recursively resolve the contents
        }
        return obj;
      } else if (obj.includes(' ')) {
        // Composite reference like "#1 #23 #44"
        const refIds = obj.split(' ').filter(id => id.startsWith('#'));
        return mergeReferences(refIds, resolvedRefs);
      }
      return obj;
    } else if (Array.isArray(obj)) {
      return obj.map(resolveRefs);
    } else if (obj && typeof obj === 'object') {
      const result = {};
      Object.keys(obj).forEach(key => {
        result[key] = resolveRefs(obj[key]);
      });
      return result;
    }
    return obj;
  }

  // Function to merge multiple references into a single object/array
  function mergeReferences(refIds, refSource) {
    const resolved = refIds.map(id => refSource[id]).filter(Boolean);

    if (resolved.length === 0) return null;
    if (resolved.length === 1) return resolved[0]; // Share the single object

    // Determine merge strategy based on types
    const firstType = Array.isArray(resolved[0]) ? 'array' : typeof resolved[0];

    if (firstType === 'object' && resolved.every(r => typeof r === 'object' && !Array.isArray(r))) {
      // Merge objects - create new object but reference shared values where possible
      const merged = {};
      resolved.forEach(obj => {
        Object.keys(obj).forEach(key => {
          if (key === 'doc' && merged[key]) {
            // Merge documentation fields by concatenating with separator
            merged[key] = merged[key] + ' | ' + obj[key];
          } else {
            merged[key] = obj[key]; // This shares the value reference
          }
        });
      });
      return merged;
    } else if (firstType === 'array' && resolved.every(r => Array.isArray(r))) {
      // Concatenate arrays and deduplicate
      const concatenated = [].concat(...resolved);
      const seen = new Set();
      return concatenated.filter(item => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
    } else {
      // Mixed types - return as array
      return resolved;
    }
  }

  // Helper function to deduplicate arrays, preserving order
  function deduplicateArray(arr) {
    if (!Array.isArray(arr)) return arr;
    const seen = new Set();
    return arr.filter(item => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  // Helper function to recursively deduplicate values arrays in objects
  function deduplicateValues(obj) {
    if (Array.isArray(obj)) {
      return obj.map(deduplicateValues);
    } else if (obj && typeof obj === 'object') {
      const result = {};
      Object.keys(obj).forEach(key => {
        if (key === 'values' && Array.isArray(obj[key])) {
          // Deduplicate values arrays specifically
          result[key] = deduplicateArray(obj[key]);
        } else {
          result[key] = deduplicateValues(obj[key]);
        }
      });
      return result;
    }
    return obj;
  }

  // Resolve all references in the main data
  Object.keys(resolved).forEach(key => {
    resolved[key] = resolveRefs(resolved[key]);
  });
  
  // Deduplicate all values arrays in the resolved data
  const finalResolved = deduplicateValues(resolved);

  return finalResolved;
}
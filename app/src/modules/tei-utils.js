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
  } 
  return teiHeader[0];
}

/**
 * Returns the <respStmt> containing a <persName> with the given xml:id or null if none can be found  
 * @param {Document} xmlDoc 
 * @param {string} id 
 * @returns {Element | null}
 */
export function getRespStmtById(xmlDoc, id) {
  for (const respStmtElem of xmlDoc.getElementsByTagName('respStmt')) {
    for (const persNameElem of respStmtElem.getElementsByTagName('persName')) {
      const xmlId = persNameElem?.getAttributeNodeNS('http://www.w3.org/XML/1998/namespace', 'id')?.value
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
  if (!(persName || persId) || !resp ) {
    throw new Error("Missing required parameters: persName, resp, or persId.");
  }
  if (getRespStmtById(xmlDoc, persId)) {
    throw new Error(`Element with xml:id="${persId}" already exists in the document.`);
  }
  const teiHeader = getTeiHeader(xmlDoc);
  let titleStmts = teiHeader.getElementsByTagName('titleStmt');
  let titleStmt;
  if (!titleStmts.length) {
    titleStmt = xmlDoc.createElementNS(teiNamespaceURI, 'titleStmt');
    teiHeader.appendChild(titleStmt);
  } else {
    titleStmt = titleStmts[0];
  }

  const respStmtElem = xmlDoc.createElementNS(teiNamespaceURI, 'respStmt');
  const persNameElem = xmlDoc.createElementNS(teiNamespaceURI, 'persName');
  persNameElem.setAttributeNS(xmlNamespace, 'xml:id', persId);
  persNameElem.textContent = persName || persId;
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
 * @property {string} [fullName] - The full name of the person making the revision.
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
  const { status = "draft", persId, desc, fullName } = revisionChange
  if (!persId || !desc) {
    throw new Error("persId and desc data required")
  }
  
  // Ensure respStmt exists for the user
  if (fullName) {
    ensureRespStmtForUser(xmlDoc, persId, fullName);
  }
  
  const currentDateString = new Date().toISOString();
  let revisionDescElements = xmlDoc.getElementsByTagName('revisionDesc');
  let revisionDescElement;
  if (!revisionDescElements.length) {
    const teiHeader = getTeiHeader(xmlDoc);
    revisionDescElement = xmlDoc.createElementNS(teiNamespaceURI, 'revisionDesc');
    teiHeader.appendChild(revisionDescElement);
  } else {
    revisionDescElement = revisionDescElements[0];
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

  // Preserve fileref from existing editionStmt if present
  let existingFileref = null;
  if (editionStmts.length > 0) {
    const lastEditionStmt = editionStmts[editionStmts.length - 1];
    const editions = lastEditionStmt.getElementsByTagName('edition');
    if (editions.length > 0) {
      const idnos = editions[0].querySelectorAll('idno[type="fileref"]');
      if (idnos.length > 0) {
        existingFileref = idnos[0].cloneNode(true);
      }
    }
    fileDesc.replaceChild(editionStmt, lastEditionStmt);
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

  // Preserve fileref if it existed
  if (existingFileref) {
    editionElem.appendChild(existingFileref);
  }

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
 * By default, only escapes characters strictly required in XML text content:
 * - & (ampersand)
 * - < (less-than)
 * - > (greater-than)
 *
 * @param {string} unsafeString The raw string that may contain special characters.
 * @param {Object} [options] Options for escaping
 * @param {boolean} [options.encodeQuotes=false] If true, also encode quotes and apostrophes (not required by XML spec for text content)
 * @returns {string} The string with special characters converted to XML entities.
 */
export function escapeXml(unsafeString, options = {}) {
  if (typeof unsafeString !== 'string') {
    return '';
  }
  let result = unsafeString
    .replaceAll(/&/g, '&amp;')
    .replaceAll(/</g, '&lt;')
    .replaceAll(/>/g, '&gt;');

  // Only encode quotes if explicitly requested
  if (options.encodeQuotes) {
    result = result
      .replaceAll(/"/g, '&quot;')
      .replaceAll(/'/g, '&apos;');
  }

  return result;
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
 * current position is inside a tag, comment, CDATA, or processing instruction.
 * Only applies escaping to regular text content, not to special XML constructs.
 *
 * By default, only escapes characters strictly required in XML text content:
 * - & (ampersand)
 * - < (less-than)
 * - > (greater-than)
 *
 * @param {string} xmlString The raw XML string to be processed.
 * @param {Object} [options] Options for escaping
 * @param {boolean} [options.encodeQuotes=false] If true, also encode quotes and apostrophes (not required by XML spec for text content)
 * @returns {string} A new XML string with its node content properly escaped.
 */
export function encodeXmlEntities(xmlString, options = {}) {
  if (typeof xmlString !== 'string') {
    return "";
  }

  let inTag = false;
  let inComment = false;
  let inCdata = false;
  let inPi = false; // processing instruction
  const resultParts = [];
  let contentBuffer = [];
  let i = 0;
  const length = xmlString.length;

  while (i < length) {
    const char = xmlString[i];

    // Check for comment start: <!--
    if (!inComment && !inCdata && !inPi && i + 3 < length) {
      if (xmlString.substring(i, i + 4) === '<!--') {
        // Flush content buffer
        if (contentBuffer.length > 0) {
          const contentToProcess = contentBuffer.join('');
          const unescapedContent = unescapeXml(contentToProcess);
          const escapedContent = escapeXml(unescapedContent, options);
          resultParts.push(escapedContent);
          contentBuffer = [];
        }

        inComment = true;
        resultParts.push('<!--');
        i += 4;
        continue;
      }
    }

    // Check for comment end: -->
    if (inComment && i + 2 < length) {
      if (xmlString.substring(i, i + 3) === '-->') {
        inComment = false;
        resultParts.push('-->');
        i += 3;
        continue;
      }
    }

    // Check for CDATA start: <![CDATA[
    if (!inComment && !inCdata && !inPi && i + 8 < length) {
      if (xmlString.substring(i, i + 9) === '<![CDATA[') {
        // Flush content buffer
        if (contentBuffer.length > 0) {
          const contentToProcess = contentBuffer.join('');
          const unescapedContent = unescapeXml(contentToProcess);
          const escapedContent = escapeXml(unescapedContent, options);
          resultParts.push(escapedContent);
          contentBuffer = [];
        }

        inCdata = true;
        resultParts.push('<![CDATA[');
        i += 9;
        continue;
      }
    }

    // Check for CDATA end: ]]>
    if (inCdata && i + 2 < length) {
      if (xmlString.substring(i, i + 3) === ']]>') {
        inCdata = false;
        resultParts.push(']]>');
        i += 3;
        continue;
      }
    }

    // Check for processing instruction start: <?
    if (!inComment && !inCdata && !inPi && i + 1 < length) {
      if (xmlString.substring(i, i + 2) === '<?') {
        // Flush content buffer
        if (contentBuffer.length > 0) {
          const contentToProcess = contentBuffer.join('');
          const unescapedContent = unescapeXml(contentToProcess);
          const escapedContent = escapeXml(unescapedContent, options);
          resultParts.push(escapedContent);
          contentBuffer = [];
        }

        inPi = true;
        resultParts.push('<?');
        i += 2;
        continue;
      }
    }

    // Check for processing instruction end: ?>
    if (inPi && i + 1 < length) {
      if (xmlString.substring(i, i + 2) === '?>') {
        inPi = false;
        resultParts.push('?>');
        i += 2;
        continue;
      }
    }

    // Handle special sections (comment, CDATA, PI) - pass through unchanged
    if (inComment || inCdata || inPi) {
      resultParts.push(char);
      i++;
      continue;
    }

    // Normal tag/content handling
    if (char === '<') {
      // When a '<' is found, the preceding text in the buffer is content.
      // Un-escape it first to prevent double-escaping, then re-escape it.
      if (contentBuffer.length > 0) {
        const contentToProcess = contentBuffer.join('');
        const unescapedContent = unescapeXml(contentToProcess);
        const escapedContent = escapeXml(unescapedContent, options);
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

    i++;
  }

  // After the loop, process any final remaining content from the buffer.
  if (contentBuffer.length > 0) {
    const contentToProcess = contentBuffer.join('');
    const unescapedContent = unescapeXml(contentToProcess);
    const escapedContent = escapeXml(unescapedContent, options);
    resultParts.push(escapedContent);
  }

  return resultParts.join('');
}

/**
 * Pretty-prints a specific DOM node by inserting whitespace text nodes for proper indentation.
 * This function modifies the node in place, adding proper indentation while preserving
 * the formatting of other parts of the document.
 * 
 * @param {Element} node - The DOM element to pretty-print
 * @param {string} [spacing='  '] - The string to use for each level of indentation
 * @returns {Element} - The modified node (same reference, modified in place)
 */
export function prettyPrintNode(node, spacing = '  ') {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('Invalid parameter: Expected Element node')
  }

  // Helper function to remove existing pure whitespace text nodes
  /** @param {ChildNode} element */
  function removeWhitespaceNodes(element) {
    const children = Array.from(element.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue) {
        // Check if the text node consists only of whitespace
        if (/^\s*$/.test(child.nodeValue)) {
          element.removeChild(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        removeWhitespaceNodes(child);
      }
    }
  }

  /** 
   * Helper function to add indentation recursively
   * @param {ChildNode} element 
   * @param {Number} depth
   * @param {Document} doc  
  */
  function addIndentation(element, depth, doc) {
    if (element.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const indent = '\n' + spacing.repeat(depth);
    const children = Array.from(element.childNodes);
    
    let lastElementChild = null;

    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        // Add indentation before the element child
        element.insertBefore(doc.createTextNode(indent + spacing), child);
        
        // Recursively indent the child's content
        addIndentation(child, depth + 1, doc);
        
        lastElementChild = child;
      }
    }

    // Add indentation before the closing tag if there were element children
    if (lastElementChild !== null) {
      element.insertBefore(doc.createTextNode(indent), lastElementChild.nextSibling);
    }
  }

  // Get the document reference
  const doc = node.ownerDocument;
  
  // Clean up any existing whitespace formatting
  removeWhitespaceNodes(node);
  
  // Add proper indentation
  const rootChildren = Array.from(node.childNodes);
  let lastProcessedChild = null;

  for (const child of rootChildren) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      // Add indent before child elements
      node.insertBefore(doc.createTextNode('\n' + spacing), child);
      
      // Recursively indent the child and its descendants  
      addIndentation(child, 1, doc);
      
      lastProcessedChild = child;
    } else if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE || 
               child.nodeType === Node.COMMENT_NODE) {
      // Handle processing instructions and comments
      const nextSibling = child.nextSibling;
      if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
        if (!(nextSibling.previousSibling && 
              nextSibling.previousSibling.nodeType === Node.TEXT_NODE && 
              nextSibling.previousSibling.nodeValue?.includes('\n'))) {
          node.insertBefore(doc.createTextNode('\n'), nextSibling);
        }
      }
      lastProcessedChild = child;
    } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim() !== '') {
      // Handle non-whitespace text nodes
      lastProcessedChild = child;
    }
  }

  // Add a final newline before the closing tag if there was content
  const actualLastChild = node.lastChild;
  if (lastProcessedChild && 
      !(actualLastChild && 
        actualLastChild.nodeType === Node.TEXT_NODE && 
        actualLastChild.nodeValue?.endsWith('\n'))) {
    node.appendChild(doc.createTextNode('\n'));
  }

  return node;
}

/**
 * Ensures a respStmt exists for the given user, creating one if necessary
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {string} username - The username to check/create respStmt for
 * @param {string} fullName - The full name of the user
 * @param {string} [responsibility='editor'] - The responsibility role
 * @returns {Element} - The existing or newly created respStmt element
 */
export function ensureRespStmtForUser(xmlDoc, username, fullName, responsibility = 'editor') {
  try {
    if (!xmlDoc) {
      throw new Error('xmlDoc is required');
    }
    if (!username) {
      throw new Error('username is required');
    }
    if (!fullName) {
      throw new Error('fullName is required');
    }
    
    // Check if respStmt already exists
    const existing = getRespStmtById(xmlDoc, username);
    if (existing) {
      return existing;
    }
    
    // Create new respStmt
    addRespStmt(xmlDoc, {
      persId: username,
      persName: fullName,
      resp: responsibility
    });
    
    // Return the newly created respStmt (should always exist at this point)
    const created = getRespStmtById(xmlDoc, username);
    if (!created) {
      throw new Error(`Failed to create respStmt for user ${username} - addRespStmt succeeded but respStmt not found afterwards`);
    }
    return created;
  } catch (error) {
    throw new Error(`ensureRespStmtForUser failed for user ${username}: ${String(error)}`);
  }
}

/**
 * Extract comprehensive document metadata from a TEI XML document using XPath queries.
 * This function mirrors the metadata extraction performed by the server-side file_data.py module.
 * 
 * @param {Document} xmlDoc - The XML Document object to extract metadata from
 * @returns {Record<string, string>} - Object containing all extracted metadata fields
 */
export function getDocumentMetadata(xmlDoc) {
  if (!xmlDoc || !xmlDoc.evaluate) {
    throw new Error('Valid XML Document with XPath support is required');
  }

  /** @param {string} prefix */
  const namespaceResolver = (prefix) => {
    /** @type {Record<string, string>} */
    const namespaces = {
      'tei': 'http://www.tei-c.org/ns/1.0'
    };
    return namespaces[prefix] || null;
  };

  const xpaths = {
    author: "//tei:teiHeader//tei:author//tei:surname",
    title: "//tei:teiHeader//tei:title",
    date: '//tei:teiHeader//tei:date[@type="publication"]',
    doi: '//tei:teiHeader//tei:idno[@type="DOI"]',
    fileref: '//tei:teiHeader//tei:idno[@type="fileref"]',
    variant_id: '//tei:application[@type="extractor"]//tei:label[@type="variant-id"]',
    last_update: '//tei:revisionDesc/tei:change[@when][last()]/@when',
    last_updated_by: '//tei:revisionDesc/tei:change[@who][last()]/@who',
    last_status: '//tei:revisionDesc/tei:change[@status][last()]/@status',
    // Additional metadata for extraction options
    extractor_id: '//tei:application[@type="extractor"]/@ident',
    extractor_version: '//tei:application[@type="extractor"]/@version',
    extractor_flavor: '//tei:application[@type="extractor"]//tei:label[@type="flavor"]'
  }
  
  const metadata = {}
  
  for (const [key, xpath] of Object.entries(xpaths)) {
    let value = null
    
    try {
      const result = xmlDoc.evaluate(
        xpath,
        xmlDoc,   
        namespaceResolver,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      
      const node = result.singleNodeValue;
      
      if (node) {
        if (node.nodeType === Node.ATTRIBUTE_NODE) {
          // Attribute node - get the value
          value = node.value?.trim() || null;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // Element node - get text content
          value = node.textContent?.trim() || null;
        }
      }
    } catch (error) {
      console.warn(`Error evaluating XPath "${xpath}" for key "${key}":`, error);
      value = null;
    }
    
    metadata[key] = value;
  }
  
  // Post-process extractor ID to match frontend extractor list format
  if (metadata.extractor_id) {
    // Convert "GROBID" to lowercase to match extractor IDs
    metadata.extractor_id = metadata.extractor_id.toLowerCase();
  }

  return metadata;
}

/**
 * Ensures the extractor variant metadata is present in the TEI XML.
 * This preserves the variant when creating new versions from existing files.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {string} variantId - The variant ID to set (e.g., "grobid.training.segmentation")
 */
export function ensureExtractorVariant(xmlDoc, variantId) {
  const teiHeader = getTeiHeader(xmlDoc);
  let encodingDesc = teiHeader.getElementsByTagName('encodingDesc')[0];

  // Create encodingDesc if it doesn't exist
  if (!encodingDesc) {
    encodingDesc = xmlDoc.createElementNS(teiNamespaceURI, 'encodingDesc');
    // Insert after fileDesc (TEI standard order)
    const fileDesc = teiHeader.getElementsByTagName('fileDesc')[0];
    if (fileDesc && fileDesc.nextSibling) {
      teiHeader.insertBefore(encodingDesc, fileDesc.nextSibling);
    } else {
      teiHeader.appendChild(encodingDesc);
    }
  }

  let appInfo = encodingDesc.getElementsByTagName('appInfo')[0];

  // Create appInfo if it doesn't exist
  if (!appInfo) {
    appInfo = xmlDoc.createElementNS(teiNamespaceURI, 'appInfo');
    encodingDesc.appendChild(appInfo);
  }

  // Find or create the extractor application element
  let extractorApp = null;
  const applications = appInfo.getElementsByTagName('application');
  for (const app of applications) {
    if (app.getAttribute('type') === 'extractor') {
      extractorApp = app;
      break;
    }
  }

  if (!extractorApp) {
    extractorApp = xmlDoc.createElementNS(teiNamespaceURI, 'application');
    extractorApp.setAttribute('type', 'extractor');
    appInfo.appendChild(extractorApp);
  }

  // Find or create the variant label element
  let variantLabel = null;
  const labels = extractorApp.getElementsByTagName('label');
  for (const label of labels) {
    if (label.getAttribute('type') === 'variant-id') {
      variantLabel = label;
      break;
    }
  }

  if (!variantLabel) {
    variantLabel = xmlDoc.createElementNS(teiNamespaceURI, 'label');
    variantLabel.setAttribute('type', 'variant-id');
    extractorApp.appendChild(variantLabel);
  }

  // Set the variant ID
  variantLabel.textContent = variantId;
}

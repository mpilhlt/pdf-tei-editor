/**
 * @file Enhancement: Enrich TEI Header from PDF Metadata
 *
 * Fetches bibliographic metadata from the backend (DOI lookup or LLM extraction)
 * and populates missing fields in the teiHeader.
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Enrich TEI Header from PDF Metadata";

/**
 * Description shown in the UI
 */
export const description = "Fetches bibliographic metadata for the current PDF (via DOI or LLM extraction) and fills in missing teiHeader fields (title, authors, date, publisher, identifiers).";

const TEI_NS = "http://www.tei-c.org/ns/1.0";

/**
 * Find the first element matching a local name under a parent, within the TEI namespace.
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element|null}
 */
function findTei(parent, localName) {
  return parent.getElementsByTagNameNS(TEI_NS, localName)[0] || null;
}

/**
 * Create a TEI-namespaced element.
 * @param {Document} doc
 * @param {string} localName
 * @param {Object<string,string>} [attrs]
 * @returns {Element}
 */
function createTei(doc, localName, attrs) {
  const el = doc.createElementNS(TEI_NS, localName);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
  }
  return el;
}

/**
 * Get text content of a TEI element, or empty string.
 * @param {Element|null} el
 * @returns {string}
 */
function textOf(el) {
  return el && el.textContent ? el.textContent.trim() : "";
}

/**
 * Find a TEI element by local name and attribute value under a parent.
 * @param {Element} parent
 * @param {string} localName
 * @param {string} attrName
 * @param {string} attrValue
 * @returns {Element|null}
 */
function findTeiByAttr(parent, localName, attrName, attrValue) {
  const elements = parent.getElementsByTagNameNS(TEI_NS, localName);
  for (const el of elements) {
    if (el.getAttribute(attrName) === attrValue) {
      return el;
    }
  }
  return null;
}

/**
 * Build a formatted citation string from metadata fields.
 * Mirrors the logic in create_tei_header() from tei_utils.py.
 * @param {Object} meta
 * @returns {string}
 */
function buildCitation(meta) {
  const authorsStr = (meta.authors || [])
    .map(a => `${a.given || ""} ${a.family || ""}`.trim())
    .join(", ");
  const parts = [`${authorsStr}. (${meta.date || ""}). ${meta.title || ""}.`];
  if (meta.journal) {
    let volIssue = meta.journal;
    if (meta.volume) {
      volIssue += `, ${meta.volume}`;
      if (meta.issue) {
        volIssue += `(${meta.issue})`;
      }
    }
    if (meta.pages) {
      volIssue += `, ${meta.pages}`;
    }
    parts.push(`${volIssue}.`);
  }
  if (meta.doi) {
    parts.push(`DOI: ${meta.doi}`);
  } else if (meta.id) {
    parts.push(meta.id);
  }
  return parts.join(" ");
}

/**
 * Fetches metadata from the backend and enriches the TEI header.
 * Only fills in fields that are currently empty or missing.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Promise<Document>} - The modified XML DOM Document object
 */
export async function execute(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  const stableId = currentState.pdf;
  if (!stableId) {
    throw new Error("No PDF document is currently open (state.pdf is empty)");
  }

  // Try to extract existing DOI from TEI header
  const teiHeader = findTei(xmlDoc.documentElement, "teiHeader");
  if (!teiHeader) {
    throw new Error("No teiHeader element found in document");
  }

  let existingDoi = "";
  const publicationStmt = findTei(teiHeader, "publicationStmt");
  if (publicationStmt) {
    const doiElem = findTeiByAttr(publicationStmt, "idno", "type", "DOI");
    if (doiElem) {
      existingDoi = textOf(doiElem);
    }
  }

  // Build query string
  const params = new URLSearchParams({ stable_id: stableId });
  if (existingDoi) {
    params.set("doi", existingDoi);
  }

  // Fetch metadata from backend (template literal required for validation)
  const response = await fetch(`/api/plugins/metadata-extraction/extract?${params}`, {
    headers: { "X-Session-ID": currentState.sessionId }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Metadata extraction failed (${response.status}): ${detail}`);
  }

  const meta = await response.json();

  // Enrich teiHeader - only fill in missing/empty fields
  const fileDesc = findTei(teiHeader, "fileDesc") || teiHeader.appendChild(createTei(xmlDoc, "fileDesc"));

  // --- titleStmt ---
  const titleStmt = findTei(fileDesc, "titleStmt") || fileDesc.insertBefore(createTei(xmlDoc, "titleStmt"), fileDesc.firstChild);

  // Title
  if (meta.title) {
    let titleElem = findTeiByAttr(titleStmt, "title", "level", "a");
    if (!titleElem) {
      titleElem = titleStmt.insertBefore(createTei(xmlDoc, "title", { level: "a" }), titleStmt.firstChild);
    }
    if (!textOf(titleElem) || textOf(titleElem) === "Unknown Title") {
      titleElem.textContent = meta.title;
    }
  }

  // Authors - only add if no authors exist yet
  if (meta.authors && meta.authors.length > 0) {
    const existingAuthors = titleStmt.getElementsByTagNameNS(TEI_NS, "author");
    if (existingAuthors.length === 0) {
      for (const author of meta.authors) {
        const authorElem = createTei(xmlDoc, "author");
        const persName = createTei(xmlDoc, "persName");
        const forename = createTei(xmlDoc, "forename");
        forename.textContent = author.given || "";
        const surname = createTei(xmlDoc, "surname");
        surname.textContent = author.family || "";
        persName.appendChild(forename);
        persName.appendChild(surname);
        authorElem.appendChild(persName);
        titleStmt.appendChild(authorElem);
      }
    }
  }

  // --- publicationStmt ---
  const pubStmt = findTei(fileDesc, "publicationStmt") || fileDesc.appendChild(createTei(xmlDoc, "publicationStmt"));

  // Publisher
  if (meta.publisher) {
    let publisherElem = findTei(pubStmt, "publisher");
    if (!publisherElem) {
      publisherElem = pubStmt.insertBefore(createTei(xmlDoc, "publisher"), pubStmt.firstChild);
    }
    if (!textOf(publisherElem)) {
      publisherElem.textContent = meta.publisher;
    }
  }

  // Date
  if (meta.date) {
    let dateElem = findTeiByAttr(pubStmt, "date", "type", "publication");
    if (!dateElem) {
      dateElem = pubStmt.appendChild(createTei(xmlDoc, "date", { type: "publication" }));
    }
    if (!textOf(dateElem)) {
      dateElem.textContent = String(meta.date);
    }
  }

  // Identifier (DOI or other)
  const doi = meta.doi;
  const id = meta.id;
  if (doi) {
    let doiElem = findTeiByAttr(pubStmt, "idno", "type", "DOI");
    if (!doiElem) {
      doiElem = pubStmt.appendChild(createTei(xmlDoc, "idno", { type: "DOI" }));
    }
    if (!textOf(doiElem)) {
      doiElem.textContent = doi;
    }
  } else if (id) {
    // Check if any idno already exists (besides fileref)
    const existingIdnos = pubStmt.getElementsByTagNameNS(TEI_NS, "idno");
    let hasNonFilerefIdno = false;
    for (const idno of existingIdnos) {
      if (idno.getAttribute("type") !== "fileref") {
        hasNonFilerefIdno = true;
        break;
      }
    }
    if (!hasNonFilerefIdno) {
      const idType = id.includes(":") ? id.split(":")[0] : "";
      if (idType) {
        const idValue = id.substring(idType.length + 1);
        const idnoElem = createTei(xmlDoc, "idno", { type: idType });
        idnoElem.textContent = idValue;
        pubStmt.appendChild(idnoElem);
      } else {
        const idnoElem = createTei(xmlDoc, "idno");
        idnoElem.textContent = id;
        pubStmt.appendChild(idnoElem);
      }
    }
  }

  // URL
  if (meta.url) {
    const existingPtr = findTei(pubStmt, "ptr");
    if (!existingPtr || !existingPtr.getAttribute("target")) {
      if (!existingPtr) {
        pubStmt.appendChild(createTei(xmlDoc, "ptr", { target: meta.url }));
      } else {
        existingPtr.setAttribute("target", meta.url);
      }
    }
  }

  // --- sourceDesc/bibl ---
  if (meta.title) {
    const sourceDesc = findTei(fileDesc, "sourceDesc") || fileDesc.appendChild(createTei(xmlDoc, "sourceDesc"));
    let biblElem = findTei(sourceDesc, "bibl");
    if (!biblElem) {
      biblElem = sourceDesc.appendChild(createTei(xmlDoc, "bibl"));
    }
    if (!textOf(biblElem)) {
      biblElem.textContent = buildCitation(meta);
    }
  }

  return xmlDoc;
}

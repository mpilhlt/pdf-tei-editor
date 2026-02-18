/**
 * @file Enhancement: Fix common issues in PDF-to-TEI extractions
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Fix Common Extraction Issues";

/**
 * Description shown in the UI
 */
export const description = "Fixes common structural issues in PDF-to-TEI extractions: reorders application children (label before ref), adds missing title elements to monogr/analytic, adds schema ref from variant-id.";

/**
 * @import { ApplicationState } from '/app/src/state.js'; 
 */

/**
 * Fixes common structural issues in TEI documents produced by PDF extraction tools.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {ApplicationState} currentState - The current application state (unused)
 * @param {Map<string, any>} configMap - The application configuration map (unused)
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  const TEI_NS = "http://www.tei-c.org/ns/1.0";

  fixApplicationChildOrder(xmlDoc, TEI_NS);
  fixApplicationRefs(xmlDoc, TEI_NS);
  addMissingTitles(xmlDoc, TEI_NS);

  return xmlDoc;
}

/**
 * In `application` elements, `label` elements must precede `ref` elements
 * per the TEI spec. This reorders children so all `label` elements come
 * before all `ref` elements, preserving relative order within each group
 * and keeping other children in place.
 *
 * @param {Document} xmlDoc
 * @param {string} ns
 */
function fixApplicationChildOrder(xmlDoc, ns) {
  const applications = xmlDoc.getElementsByTagNameNS(ns, "application");
  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    const children = Array.from(app.childNodes);

    // Collect labels, refs, and other nodes
    const labels = [];
    const refs = [];
    const others = [];

    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const localName = child.localName || child.nodeName.split(":").pop();
        if (localName === "label") {
          labels.push(child);
        } else if (localName === "ref") {
          refs.push(child);
        } else {
          others.push(child);
        }
      }
    }

    // Only reorder if there are both labels and refs
    if (labels.length === 0 || refs.length === 0) {
      continue;
    }

    // Check if reordering is needed: find first ref and last label positions
    let needsReorder = false;
    const elementChildren = children.filter(c => c.nodeType === Node.ELEMENT_NODE);
    let firstRefIdx = -1;
    let lastLabelIdx = -1;
    for (let j = 0; j < elementChildren.length; j++) {
      const localName = elementChildren[j].localName || elementChildren[j].nodeName.split(":").pop();
      if (localName === "ref" && firstRefIdx === -1) {
        firstRefIdx = j;
      }
      if (localName === "label") {
        lastLabelIdx = j;
      }
    }
    if (firstRefIdx < lastLabelIdx) {
      // A ref appears before a label somewhere - but we need a stricter check:
      // any ref before any label means reorder needed
      needsReorder = true;
    }

    if (!needsReorder) {
      continue;
    }

    // Rebuild: labels first, then refs, then other elements,
    // with whitespace text nodes preserved around their associated elements.
    // Remove all children first
    while (app.firstChild) {
      app.removeChild(app.firstChild);
    }

    // Re-append in correct order: labels, then refs, then others
    const ordered = [...labels, ...refs, ...others];
    for (const node of ordered) {
      // Add indentation text node before each element
      app.appendChild(xmlDoc.createTextNode("\n        "));
      app.appendChild(node);
    }
    // Add closing indentation
    app.appendChild(xmlDoc.createTextNode("\n      "));
  }
}

/**
 * Schema base URLs keyed by extractor ident prefix.
 * Used to derive the schema ref from the variant-id label.
 */
const SCHEMA_BASE_URLS = {
  "llamore": "https://mpilhlt.github.io/llamore/schema",
  "grobid":  "https://mpilhlt.github.io/grobid-footnote-flavour/schema",
};

/**
 * Adds a schema `<ref>` (with `.rng` target) to extractor `application`
 * elements that don't already have one. The schema URL is derived from
 * the `variant-id` label and the extractor ident.
 *
 * @param {Document} xmlDoc
 * @param {string} ns
 */
function fixApplicationRefs(xmlDoc, ns) {
  const applications = xmlDoc.getElementsByTagNameNS(ns, "application");
  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    if (app.getAttribute("type") !== "extractor") continue;

    // Check if a schema ref (target ending in .rng) already exists
    const refs = app.getElementsByTagNameNS(ns, "ref");
    let hasSchemaRef = false;
    for (let j = 0; j < refs.length; j++) {
      const target = refs[j].getAttribute("target") || "";
      if (target.endsWith(".rng")) {
        hasSchemaRef = true;
        break;
      }
    }
    if (hasSchemaRef) continue;

    // Read variant-id from label
    const labels = app.getElementsByTagNameNS(ns, "label");
    let variantId = null;
    for (let j = 0; j < labels.length; j++) {
      if (labels[j].getAttribute("type") === "variant-id") {
        variantId = labels[j].textContent?.trim() || null;
        break;
      }
    }
    if (!variantId) continue;

    // Determine schema base URL from the extractor ident
    const ident = app.getAttribute("ident") || "";
    let schemaBaseUrl = null;
    for (const [prefix, url] of Object.entries(SCHEMA_BASE_URLS)) {
      if (ident.toLowerCase().startsWith(prefix)) {
        schemaBaseUrl = url;
        break;
      }
    }
    if (!schemaBaseUrl) continue;

    const schemaUrl = `${schemaBaseUrl}/${variantId}.rng`;
    const schemaRef = xmlDoc.createElementNS(ns, "ref");
    schemaRef.setAttribute("target", schemaUrl);

    // Append after last ref, or at end of application
    const lastRef = refs.length > 0 ? refs[refs.length - 1] : null;
    if (lastRef && lastRef.nextSibling) {
      app.insertBefore(xmlDoc.createTextNode("\n        "), lastRef.nextSibling);
      app.insertBefore(schemaRef, lastRef.nextSibling.nextSibling);
    } else {
      app.appendChild(xmlDoc.createTextNode("\n        "));
      app.appendChild(schemaRef);
    }
  }
}

/**
 * Adds an empty `title` element as the first child of any `monogr` or
 * `analytic` element that lacks one. A `title` child is required by the
 * TEI spec for these elements.
 *
 * @param {Document} xmlDoc
 * @param {string} ns
 */
function addMissingTitles(xmlDoc, ns) {
  const tagNames = ["monogr", "analytic"];
  for (const tagName of tagNames) {
    const elements = xmlDoc.getElementsByTagNameNS(ns, tagName);
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];

      // Check if a title child already exists
      const existingTitles = el.getElementsByTagNameNS(ns, "title");
      let hasDirectTitle = false;
      for (let j = 0; j < existingTitles.length; j++) {
        if (existingTitles[j].parentNode === el) {
          hasDirectTitle = true;
          break;
        }
      }

      if (!hasDirectTitle) {
        const title = xmlDoc.createElementNS(ns, "title");
        // Insert as first child element, after any leading whitespace
        const firstChild = el.firstChild;
        if (firstChild) {
          el.insertBefore(title, firstChild);
          // Add whitespace after the inserted title for formatting
          el.insertBefore(xmlDoc.createTextNode("\n"), title.nextSibling);
        } else {
          el.appendChild(title);
        }
      }
    }
  }
}

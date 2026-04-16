/**
 * @file Enhancement: Collapse all `bibl` children of the parent `listBibl` back into
 * plain mixed content by removing `bibl` and `label` wrapper elements.
 *
 * This is the inverse of the "Segment along footnote numbers" enhancement. It only
 * runs when the normative xpath resolves to a `bibl` element whose parent is a
 * `listBibl` element. The `listBibl` element itself is kept; its `bibl` children are
 * unwrapped and their `label` children are discarded. Non-`bibl`/`label` elements
 * (e.g. `<lb/>`) and non-whitespace text inside `bibl` elements are preserved.
 * Whitespace-only text nodes between sibling `bibl` elements are dropped.
 *
 * ## Testing Notes
 *
 * JSDOM has limited XPath support, particularly for namespace resolvers. Export a helper
 * function that accepts the target element directly so tests can bypass XPath resolution.
 *
 * Example:
 * ```javascript
 * import { desegmentListBibl } from './desegment-footnotes.js';
 * const listBibl = xmlDoc.getElementsByTagNameNS(TEI_NS, 'listBibl')[0];
 * desegmentListBibl(listBibl, xmlDoc);
 * ```
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Desegment footnotes in <listBibl>";

/**
 * Description shown in the UI
 */
export const description = "Remove <bibl> and <label> wrappers from the parent <listBibl> of the selected element, collapsing all footnote references back into plain mixed content. Only runs when the selected element is a <bibl> inside a <listBibl>.";

const TEI_NS = "http://www.tei-c.org/ns/1.0";

/**
 * @import { ApplicationState } from '/app/src/state.js';
 */

/**
 * Removes `bibl`/`label` segmentation from the `listBibl` that contains the
 * currently selected element.
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
    console.warn("[desegment-footnotes] No xpath in current state");
    return xmlDoc;
  }

  // Remove index suffix — we only need one node to find the parent listBibl
  const cleanXpath = xpath.replace(/\[\d+\]$/, "");

  const nsResolver = (prefix) => {
    if (prefix === "tei") return TEI_NS;
    return null;
  };

  let result;
  try {
    result = xmlDoc.evaluate(
      cleanXpath,
      xmlDoc,
      nsResolver,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
  } catch (e) {
    console.warn(`[desegment-footnotes] Invalid xpath '${xpath}': ${e.message}`);
    return xmlDoc;
  }

  // Resolve the listBibl to operate on.
  // Primary: the selected node's parent, if it is a tei:listBibl.
  // Fallback: any tei:listBibl inside tei:text (used when the xpath is stale after a
  //           previous desegmentation removed all bibl children).
  let listBibl = null;

  const selectedNode = result.singleNodeValue;
  if (selectedNode) {
    const parent = selectedNode.parentNode;
    const parentLocal = parent?.localName || parent?.nodeName.split(":").pop();
    const parentNs = parent?.namespaceURI ||
      (parent?.nodeName.includes(":") ? TEI_NS : null);
    if (parentLocal === "listBibl" && parentNs === TEI_NS) {
      listBibl = /** @type {Element} */ (parent);
    }
  }

  if (!listBibl) {
    console.log(`[desegment-footnotes] Selected node has no listBibl parent — trying fallback xpath`);
    const fallback = xmlDoc.evaluate(
      "//tei:text//tei:listBibl",
      xmlDoc,
      nsResolver,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    listBibl = /** @type {Element|null} */ (fallback.singleNodeValue);
  }

  if (!listBibl) {
    console.warn("[desegment-footnotes] No tei:listBibl found in document");
    return xmlDoc;
  }

  desegmentListBibl(listBibl, xmlDoc);
  return xmlDoc;
}

/**
 * Removes `bibl` and `label` wrapper elements from a `listBibl` element,
 * collapsing all segmented footnote content back into plain mixed content.
 *
 * - `bibl` elements are unwrapped: their children replace them in document order.
 * - `label` elements inside `bibl` elements are discarded entirely.
 * - Other elements (e.g. `<lb/>`) are kept as-is.
 * - `bibl` and `label` elements are unwrapped: their children replace them in document
 *   order. All text content — including footnote numbers inside `label` elements — is
 *   faithfully preserved.
 * - Whitespace-only text nodes that are direct children of `listBibl` (inter-`bibl`
 *   newlines/spaces) are dropped. All other nodes are kept exactly as-is.
 *
 * This function is exported for direct testing without XPath resolution.
 *
 * @param {Element} listBiblElement - The `listBibl` element to desegment
 * @param {Document} xmlDoc - The XML DOM Document object (for node adoption)
 * @returns {boolean} - True if the element was modified, false otherwise
 */
export function desegmentListBibl(listBiblElement, xmlDoc) {
  const localName = listBiblElement.localName || listBiblElement.nodeName.split(":").pop();
  const namespaceURI = listBiblElement.namespaceURI ||
    (listBiblElement.nodeName.includes(":") ? TEI_NS : null);

  if (localName !== "listBibl" || namespaceURI !== TEI_NS) {
    console.warn("[desegment-footnotes] Target node is not a tei:listBibl element");
    return false;
  }

  const newChildren = [];

  for (const child of listBiblElement.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Drop whitespace-only text between sibling <bibl> elements (formatting artefact).
      // Any non-whitespace text is kept as-is.
      if (child.textContent.trim() !== "") {
        newChildren.push(child.cloneNode(true));
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childLocal = child.localName || child.nodeName.split(":").pop();
      if (childLocal === "bibl") {
        // Unwrap bibl: collect its descendants, unwrapping any nested label elements too
        collectUnwrapped(child, newChildren);
      } else {
        newChildren.push(child.cloneNode(true));
      }
    } else {
      newChildren.push(child.cloneNode(true));
    }
  }

  // Replace children
  while (listBiblElement.firstChild) {
    listBiblElement.removeChild(listBiblElement.firstChild);
  }
  for (const node of newChildren) {
    listBiblElement.appendChild(xmlDoc.importNode(node, true));
  }

  return true;
}

/**
 * Recursively collects the children of `element` into `output`, unwrapping any
 * `bibl` or `label` elements encountered (i.e. replacing them with their own
 * children). All text nodes and non-`bibl`/`label` elements are pushed as-is.
 *
 * @param {Element} element
 * @param {Node[]} output
 */
function collectUnwrapped(element, output) {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const local = child.localName || child.nodeName.split(":").pop();
      if (local === "bibl" || local === "label") {
        // Unwrap: descend into the element without emitting the tag itself
        collectUnwrapped(/** @type {Element} */ (child), output);
        continue;
      }
    }
    output.push(child.cloneNode(true));
  }
}

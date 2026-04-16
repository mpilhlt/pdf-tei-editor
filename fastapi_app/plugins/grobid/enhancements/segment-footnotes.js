/**
 * @file Enhancement: Segment footnotes in a selected element by inserting `bibl` and `label` tags.
 *
 * This enhancement detects sequential footnote numbers inside the selecte node 
 * and wraps each segment in a `<bibl>` element with a `<label>` for the number.
 *
 * ## Testing Notes
 *
 * JSDOM has limited XPath support, particularly for namespace resolvers. Export a helper
 * function that accepts the target element directly so tests can bypass XPath resolution.
 *
 * Example:
 * ```javascript
 * import { segmentElement } from './segment-footnotes.js';
 * const note = xmlDoc.getElementsByTagNameNS(TEI_NS, 'note')[0];
 * segmentElement(note, xmlDoc);
 * ```
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Segment along footnote numbers";

/**
 * Description shown in the UI
 */
export const description = "Insert <bibl> and <label> tags into the selected element to segment footnote references. The first integer found in the content is used as the starting footnote number, and sequential numbers are segmented accordingly.";

const TEI_NS = "http://www.tei-c.org/ns/1.0";

/**
 * @import { ApplicationState } from '/app/src/state.js';
 */

/**
 * Segments footnote references inside the selected element.
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
    console.warn("[segment-footnotes] No xpath in current state");
    return xmlDoc;
  }

  // Remove locator suffix before evaluating
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
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
  } catch (e) {
    console.warn(`[segment-footnotes] Invalid xpath '${xpath}': ${e.message}`);
    return xmlDoc;
  }

  if (result.snapshotLength === 0) {
    // Fallback: the xpath is stale (e.g. after desegmentation removed all bibl elements).
    // Try the listBibl that contains the unsegmented text directly.
    console.log(`[segment-footnotes] No nodes found for xpath '${xpath}', trying fallback //tei:text//tei:listBibl`);
    const fallback = xmlDoc.evaluate(
      "//tei:text//tei:listBibl",
      xmlDoc,
      nsResolver,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const fallbackNode = fallback.singleNodeValue;
    if (!fallbackNode) {
      console.warn("[segment-footnotes] No fallback tei:listBibl found in document");
      return xmlDoc;
    }
    segmentElement(/** @type {Element} */ (fallbackNode), xmlDoc);
    return xmlDoc;
  }

  for (let i = 0; i < result.snapshotLength; i++) {
    segmentElement(result.snapshotItem(i), xmlDoc);
  }

  return xmlDoc;
}

/**
 * Segments a single element by inserting `bibl` and `label` tags around
 * sequential footnote numbers. This function is exported for direct testing without
 * XPath resolution.
 *
 * @param {Element} selectedElement - The  element to segment
 * @param {Document} xmlDoc - The XML DOM Document object (for creating new nodes)
 * @returns {boolean} - True if segmentation was applied, false otherwise
 */
export function segmentElement(selectedElement, xmlDoc) {
  const localName = selectedElement.localName || selectedElement.nodeName.split(":").pop();
  const namespaceURI = selectedElement.namespaceURI ||
    (selectedElement.nodeName.includes(":") ? TEI_NS : null);

  const textContent = selectedElement.textContent || "";

  // Find the first integer in the content to use as the starting footnote number
  const firstMatch = textContent.match(/\d+/);
  if (!firstMatch) {
    console.warn("[segment-footnotes] No integer found in note content");
    return false;
  }
  const startNumber = parseInt(firstMatch[0], 10);

  // Serialize the inner XML of the element. XMLSerializer adds xmlns declarations to
  // every element serialized in isolation; strip them so the wrapper's namespace
  // declaration covers the whole fragment without redundant repetition.
  const serializer = new XMLSerializer();
  let innerXml = "";
  for (const child of selectedElement.childNodes) {
    innerXml += serializer.serializeToString(child);
  }
  innerXml = innerXml.replaceAll(` xmlns="${TEI_NS}"`, "");

  // Insert bibl/label tags around sequential footnote numbers
  const segmented = insertBiblTags(innerXml, startNumber);

  // If nothing was inserted, there is nothing to do
  if (segmented === innerXml) {
    console.warn("[segment-footnotes] No sequential footnote numbers found to segment");
    return false;
  }

  // Wrap: open the first bibl explicitly, close the last one after the segmented content.
  // insertBiblTags opens bibls only for numbers 2, 3, … (via </bibl>\n<bibl>), so the
  // first bibl must be opened here.
  const wrapped = `<${localName} xmlns="${TEI_NS}"><bibl>${segmented}</bibl></${localName}>`;

  let parsedDoc;
  try {
    parsedDoc = new DOMParser().parseFromString(wrapped, "application/xml");
  } catch (e) {
    console.warn(`[segment-footnotes] Failed to parse segmented content: ${e.message}`);
    return false;
  }

  const parseError = parsedDoc.querySelector("parsererror");
  if (parseError) {
    console.warn(`[segment-footnotes] Parse error in segmented content: ${parseError.textContent}`);
    return false;
  }

  const parsedNote = parsedDoc.documentElement;

  // Replace the note's children with the new segmented children
  while (selectedElement.firstChild) {
    selectedElement.removeChild(selectedElement.firstChild);
  }

  for (const child of Array.from(parsedNote.childNodes)) {
    selectedElement.appendChild(xmlDoc.importNode(child, true));
  }

  return true;
}

/**
 * Inserts `<label>N</label>` and `</bibl>\n<bibl>` markers into a serialized XML
 * string at positions where sequential footnote numbers are found.
 *
 * - The first occurrence of `startNumber` is replaced by `<label>N</label>` only.
 *   The caller is responsible for opening the first `<bibl>` before the returned string.
 * - Each subsequent sequential number is replaced by `</bibl>\n<bibl><label>N</label>`,
 *   closing the previous bibl and opening the next.
 * - The caller is responsible for closing the final `</bibl>` after the returned string.
 *
 * A number is recognised when it is at the start of the string, preceded by whitespace
 * or a closing XML tag (`>`), and followed by whitespace or an opening XML tag (`<`).
 *
 * @param {string} str - Serialized inner XML of the element to segment
 * @param {number} startNumber - The first footnote number to look for
 * @returns {string} - The modified string with label/bibl markers inserted
 */
function insertBiblTags(str, startNumber) {
  let n = startNumber;

  // Match a standalone integer that is:
  //   - at the start of the string, or preceded by whitespace or a closing XML tag (>)
  //   - followed by whitespace or an opening XML tag (<)
  // This covers numbers at the start of serialized XML content and numbers that follow
  // self-closing elements such as <lb/>, e.g. "\n123<lb/>" or "> 5 <lb/>".
  const anyNumber = /(?:^|(?<=[\s>]))(\d+)(?=[\s<])/g;

  let result = str;
  let offset = 0;

  for (const match of str.matchAll(anyNumber)) {
    const found = parseInt(match[1], 10);

    if (found === n) {
      const label = `<label>${n}</label>`;
      const insertion = n === startNumber
        ? label
        : `</bibl>\n        <bibl>${label}`;

      const pos = match.index + offset;
      result = result.slice(0, pos) + insertion + result.slice(pos + match[1].length);
      offset += insertion.length - match[1].length;
      n++;
    }
  }

  return result;
}

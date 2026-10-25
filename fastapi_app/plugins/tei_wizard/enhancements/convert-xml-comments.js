/**
 * @file Enhancement: Converts the XML comments inside `<text>` into unit comments.
 *
 * Each comment becomes a comment thread in `TEI/standOff/listAnnotation[@type="unit-comment"]`
 * (see docs/user-manual/unit-comments.md), by the current user, and is removed from the text.
 * A comment directly followed by an element (only whitespace in between) is attached to that
 * element, since a comment usually precedes what it is about; any other comment is attached to
 * its parent element. The thread is anchored by the element's XPath only; the editor adds the
 * content fingerprint the next time it writes the comments.
 *
 * The XPath format must stay the same as `elementPath()` in app/src/modules/node-anchor.js.
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Convert XML comments";

/**
 * Description shown in the UI
 */
export const description = "Turns the XML comments inside <text> into comments on elements (stored in the standOff), so that they show in the editor's comment gutter and the diagnostics drawer.";

const TEI_NS = "http://www.tei-c.org/ns/1.0";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const LIST_TYPE = "unit-comment";

/**
 * Returns the direct child elements of a node with the given local name.
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element[]}
 */
function childrenByName(parent, localName) {
  return Array.from(parent.children).filter(el => el.localName === localName);
}

/**
 * Returns the XPath of an element: one step per element from the root, with a position in
 * brackets only where the parent has several children of that name.
 * @param {Element} element
 * @returns {string}
 */
export function domElementPath(element) {
  const steps = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const siblings = node.parentElement ? childrenByName(node.parentElement, node.localName) : [node];
    steps.unshift(siblings.length > 1 ? `${node.localName}[${siblings.indexOf(node) + 1}]` : node.localName);
  }
  return "/" + steps.join("/");
}

/**
 * Returns the element a comment is about: the next element if only whitespace lies between, or the parent.
 * @param {Comment} comment
 * @returns {Element|null}
 */
function commentTarget(comment) {
  for (let next = comment.nextSibling; next; next = next.nextSibling) {
    if (next.nodeType === 1) return /** @type {Element} */ (next);
    if (next.nodeType === 3 && !(next.textContent ?? "").trim()) continue;
    break;
  }
  return comment.parentElement;
}

/**
 * Returns the indentation of the line an element starts on, from the whitespace before it.
 * @param {Element} element
 * @returns {string}
 */
function indentOf(element) {
  const prev = element.previousSibling;
  const match = prev && prev.nodeType === 3 ? /\n([ \t]*)$/.exec(prev.textContent ?? "") : null;
  return match ? match[1] : "";
}

/**
 * Creates a TEI element.
 * @param {Document} xmlDoc
 * @param {string} localName
 * @param {Record<string, string>} [attributes]
 * @param {string} [text]
 * @returns {Element}
 */
function teiElement(xmlDoc, localName, attributes = {}, text) {
  const el = xmlDoc.createElementNS(TEI_NS, localName);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "xml:id") el.setAttributeNS(XML_NS, key, value);
    else el.setAttribute(key, value);
  }
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Returns the comment list, creating `standOff` (after the `teiHeader`) and the list if needed.
 * @param {Document} xmlDoc
 * @param {Element} root
 * @returns {Element}
 */
function commentList(xmlDoc, root) {
  let standOff = childrenByName(root, "standOff")[0];
  const header = childrenByName(root, "teiHeader")[0];
  const rootIndent = header ? indentOf(header) : "  ";
  if (!standOff) {
    standOff = teiElement(xmlDoc, "standOff");
    standOff.appendChild(xmlDoc.createTextNode("\n" + rootIndent));
    const before = header ? header.nextSibling : root.firstChild;
    root.insertBefore(xmlDoc.createTextNode("\n" + rootIndent), before);
    root.insertBefore(standOff, before);
  }
  let list = childrenByName(standOff, "listAnnotation").find(l => l.getAttribute("type") === LIST_TYPE);
  if (!list) {
    const indent = indentOf(standOff) || rootIndent;
    list = teiElement(xmlDoc, "listAnnotation", { type: LIST_TYPE, subtype: "fp-sha256-8-v1" });
    // before the whitespace that precedes the close tag
    const last = standOff.lastChild;
    const before = last && last.nodeType === 3 && !(last.textContent ?? "").trim() ? last : null;
    standOff.insertBefore(xmlDoc.createTextNode("\n" + indent + "  "), before);
    standOff.insertBefore(list, before);
    if (!before) standOff.appendChild(xmlDoc.createTextNode("\n" + indent));
  }
  return list;
}

/**
 * Adds a respStmt for the user to the titleStmt if there is none.
 * @param {Document} xmlDoc
 * @param {Element} root
 * @param {string} username
 * @param {string} fullname
 */
function ensureRespStmt(xmlDoc, root, username, fullname) {
  const persNames = Array.from(root.getElementsByTagNameNS(TEI_NS, "persName"));
  if (persNames.some(p => p.getAttributeNS(XML_NS, "id") === username || p.getAttribute("xml:id") === username)) return;
  const header = childrenByName(root, "teiHeader")[0];
  const fileDesc = header ? childrenByName(header, "fileDesc")[0] : null;
  const titleStmt = fileDesc ? childrenByName(fileDesc, "titleStmt")[0] : null;
  if (!titleStmt) return;
  const respStmt = teiElement(xmlDoc, "respStmt");
  respStmt.appendChild(teiElement(xmlDoc, "persName", { "xml:id": username }, fullname));
  respStmt.appendChild(teiElement(xmlDoc, "resp", {}, "Commenter"));
  const last = titleStmt.lastChild;
  const before = last && last.nodeType === 3 && !(last.textContent ?? "").trim() ? last : null;
  const first = titleStmt.firstElementChild;
  if (first) titleStmt.insertBefore(xmlDoc.createTextNode("\n" + indentOf(first)), before);
  titleStmt.insertBefore(respStmt, before);
}

/**
 * The enhancement function.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  const root = xmlDoc.documentElement;
  const text = root ? childrenByName(root, "text")[0] : null;
  if (!root || !text) return xmlDoc;
  const comments = [];
  const walker = xmlDoc.createTreeWalker(text, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(/** @type {Comment} */ (node));
  if (!comments.length) return xmlDoc;

  const user = /** @type {any} */ (currentState)?.user;
  const author = user?.username || "unknown";
  const when = new Date().toISOString();
  const list = commentList(xmlDoc, root);
  const indent = indentOf(list);
  const used = new Set(Array.from(list.getElementsByTagNameNS(TEI_NS, "annotation")).map(a => a.getAttributeNS(XML_NS, "id") || a.getAttribute("xml:id")));
  const newId = () => {
    for (;;) {
      const id = "uc-" + Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };

  // the paths are taken before any comment is removed: removing comments does not change them
  const entries = comments
    .map(comment => ({ comment, target: commentTarget(comment), text: (comment.data ?? "").trim() }))
    .filter(entry => entry.target && entry.text);
  const aIndent = indent + "  ", cIndent = aIndent + "  ";
  for (const { target, text: commentText } of entries) {
    const annotation = teiElement(xmlDoc, "annotation", {
      "xml:id": newId(), motivation: "commenting", target: `#xpath(${domElementPath(/** @type {Element} */ (target))})`, resp: `#${author}`
    });
    const revisionDesc = teiElement(xmlDoc, "revisionDesc");
    revisionDesc.append(xmlDoc.createTextNode("\n" + cIndent + "  "), teiElement(xmlDoc, "change", { when, who: `#${author}` }), xmlDoc.createTextNode("\n" + cIndent));
    annotation.append(
      xmlDoc.createTextNode("\n" + cIndent), revisionDesc,
      xmlDoc.createTextNode("\n" + cIndent), teiElement(xmlDoc, "note", { type: "comment" }, commentText),
      xmlDoc.createTextNode("\n" + aIndent)
    );
    list.appendChild(annotation);
  }
  // one annotation per line
  for (const child of Array.from(list.childNodes)) {
    if (child.nodeType === 3 && !(child.textContent ?? "").trim()) child.remove();
  }
  for (const child of Array.from(list.children)) list.insertBefore(xmlDoc.createTextNode("\n" + aIndent), child);
  list.appendChild(xmlDoc.createTextNode("\n" + indent));

  for (const comment of comments) {
    // a comment on a line of its own takes the line with it
    const prev = comment.previousSibling;
    const next = comment.nextSibling;
    if (prev && prev.nodeType === 3 && /\n[ \t]*$/.test(prev.textContent ?? "") && (!next || (next.nodeType === 3 && /^[ \t]*\n/.test(next.textContent ?? "")))) {
      prev.textContent = (prev.textContent ?? "").replace(/\n[ \t]*$/, "");
    }
    comment.remove();
  }
  ensureRespStmt(xmlDoc, root, author, user?.fullname || author);
  return xmlDoc;
}

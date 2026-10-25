/**
 * Turns bare http(s) URLs in user-supplied plain text (comments, messages, diagnostics) into
 * clickable links that open in a new tab.
 *
 * The text is never parsed as HTML: {@link linkifyNodes} builds text nodes and anchors, so it is
 * safe for untrusted content. Only `http:` and `https:` URLs become links.
 */

/** Candidate URLs: scheme, then everything up to whitespace or characters that cannot end a bare URL */
const URL_CANDIDATE = /https?:\/\/[^\s<>"]+/gi;

/** Characters that end a sentence or quote rather than the URL */
const TRAILING_PUNCTUATION = '.,;:!?\'"*”’»';

/** Closing brackets that belong to the URL only when it contains the matching opening one */
const BRACKETS = { ')': '(', ']': '[', '}': '{' };

/**
 * A part of a text split at URLs
 * @typedef {object} UrlPart
 * @property {string} text - The text as it appears in the input
 * @property {string|null} url - The link target for URLs, null for plain text
 */

/**
 * Removes trailing punctuation and unbalanced closing brackets from a URL candidate.
 * @param {string} candidate
 * @returns {string}
 */
function trimUrl(candidate) {
  let url = candidate;
  for (;;) {
    const last = url.slice(-1);
    if (TRAILING_PUNCTUATION.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const open = BRACKETS[/** @type {keyof typeof BRACKETS} */ (last)];
    if (open && url.split(open).length < url.split(last).length) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/**
 * Returns the text if it is a valid http(s) URL with a host, otherwise null. The text is
 * returned as written, so that the link target matches what the user sees.
 * @param {string} text
 * @returns {string|null}
 */
function safeHttpUrl(text) {
  try {
    const url = new URL(text);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Splits a text into plain parts and http(s) URLs. Trailing punctuation and unbalanced closing
 * brackets are not part of a URL. Adjacent plain parts are never produced.
 * @param {string} text
 * @returns {UrlPart[]}
 */
export function splitUrls(text) {
  /** @type {UrlPart[]} */
  const parts = [];
  let plain = '';
  let last = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const start = /** @type {number} */ (match.index);
    const candidate = trimUrl(match[0]);
    const url = safeHttpUrl(candidate);
    if (!url) continue;
    plain += text.slice(last, start);
    if (plain) parts.push({ text: plain, url: null });
    plain = '';
    parts.push({ text: candidate, url });
    last = start + candidate.length;
  }
  plain += text.slice(last);
  if (plain) parts.push({ text: plain, url: null });
  return parts;
}

/**
 * Creates an anchor that opens a URL in a new tab.
 * @param {string} text - The visible text
 * @param {string} url - The link target (must be a safe http(s) URL)
 * @returns {HTMLAnchorElement}
 */
export function createExternalLink(text, url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  // links are often inside clickable containers (diagnostics entries, message items)
  a.addEventListener('click', event => event.stopPropagation());
  return a;
}

/**
 * Converts a text into DOM nodes in which http(s) URLs are links opening in a new tab.
 * @param {string} text
 * @param {(text: string) => Node[]} [renderPlain] - Renders the plain (non-URL) parts; text nodes by default
 * @returns {Node[]}
 */
export function linkifyNodes(text, renderPlain = plain => [document.createTextNode(plain)]) {
  return splitUrls(text).flatMap(part =>
    part.url ? [createExternalLink(part.text, part.url)] : renderPlain(part.text));
}

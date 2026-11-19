/**
 * The `<text>` of a zone document as lines and pieces, and its pages.
 *
 * JavaScript mirror of the reading part of `fastapi_app/lib/tei/zone_lines.py`: in a zone document
 * (such as `grobid.training.segmentation`) the children of `<text>` are zones that partition one
 * text stream. A line is the content up to and including an `<lb/>` (text after the last `<lb/>`
 * is a last line), a piece the part of a line in one zone, with the short code of its zone (`-`
 * outside any zone). Pages are consecutive lines with the same page index of the document's line
 * layout (`GET /api/v1/files/{stable_id}/layout`); a page's fingerprint is computed from its pieces,
 * so the page units of the unit review match those the LLM plugins compute on the server.
 * `tests/fixtures/zone-lines/` holds the fixtures both implementations are tested with.
 *
 * This module has no dependency on the application.
 */

import { sha256Hex } from './sha256.js';

/** Label of text outside any zone */
export const OUTSIDE = '-';

/**
 * A zone label, as declared by an extractor in `zoneLabels`
 * @typedef {object} ZoneLabel
 * @property {string} code - Short code, e.g. `note:headnote`
 * @property {string} element - Element name, e.g. `note`
 * @property {Object<string, string>} [attributes] - Attributes, e.g. `{place: 'headnote'}`
 */

/**
 * The part of a line in one zone
 * @typedef {object} Piece
 * @property {string} label
 * @property {string} text - Whitespace collapsed
 */

/**
 * A line of the text stream
 * @typedef {object} ZoneLine
 * @property {number} from - Offset of the line's first text character (or of its `<lb/>`)
 * @property {number} to - Offset after the line's last text character or `<lb/>`
 * @property {Piece[]} pieces
 * @property {string} emptyLabel - Label of a line without text: the zone of its `<lb/>`
 */

/**
 * A page of a zone document
 * @typedef {object} ZonePage
 * @property {number} number - Page number from the layout (1-based)
 * @property {number} firstLine
 * @property {number} endLine - Exclusive
 * @property {number} from - Offset of the page's first text character
 * @property {number} to - Offset after the page's last text character or `<lb/>`
 * @property {string} fingerprint - 8 hex characters, plus `.n` for the n-th page with identical content
 */

// whitespace as in zone_lines.py, which uses the class of JavaScript's \s
const WS_RE = /\s+/g;
const IS_WS_RE = /^\s$/;

const TOKEN_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/)?([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>|&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g;
const TEXT_OPEN_RE = /<(?:[\w.-]+:)?text\b(?:"[^"]*"|'[^']*'|[^>"'])*>/;
const TEXT_CLOSE_RE = /<\/(?:[\w.-]+:)?text\s*>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
const NAMED = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

/**
 * @param {string} name
 * @returns {string}
 */
const localName = name => name.split(':').pop() ?? name;

/**
 * Collapses whitespace runs to one space and trims.
 * @param {string} text
 * @returns {string}
 */
export function collapse(text) {
  return text.replace(WS_RE, ' ').trim();
}

/**
 * Decodes the character and entity references in an attribute value.
 * @param {string} value
 * @returns {string}
 */
function decodeText(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (all, dec, hex, named) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (NAMED[named] ?? all));
}

/**
 * The code of a zone element: the most specific matching label, else `<element>[:<first attribute value>]`.
 * @param {ZoneLabel[]} labels
 * @param {string} element
 * @param {string} rawAttributes
 * @returns {string}
 */
function codeOf(labels, element, rawAttributes) {
  /** @type {Record<string, string>} */
  const attrs = {};
  /** @type {string[]} */
  const values = [];
  for (const [, name, value] of rawAttributes.matchAll(ATTR_RE)) {
    const key = /** @type {string} */ (name).startsWith('xml:') ? /** @type {string} */ (name) : localName(/** @type {string} */ (name));
    const decoded = decodeText(/** @type {string} */ (value).slice(1, -1));
    attrs[key] = decoded;
    if (!key.startsWith('xml')) values.push(decoded);
  }
  const name = localName(element);
  /** @type {ZoneLabel|null} */
  let best = null;
  for (const label of labels) {
    if (label.element !== name) continue;
    const required = Object.entries(label.attributes ?? {});
    if (required.some(([k, v]) => attrs[k] !== v)) continue;
    if (!best || required.length > Object.keys(best.attributes ?? {}).length) best = label;
  }
  if (best) return best.code;
  return values.length ? `${name}:${values[0]}` : name;
}

/**
 * Reads the lines of a zone document's `<text>`.
 * @param {string} xml - The whole document
 * @param {ZoneLabel[]} labels - The variant's zone labels
 * @returns {ZoneLine[]}
 * @throws {Error} No `<text>` element, or a zone contains elements other than `<lb/>` and `<pb/>`
 */
export function readZoneLines(xml, labels) {
  const open = TEXT_OPEN_RE.exec(xml);
  if (!open) throw new Error('The document has no <text> element');
  let close = null;
  TEXT_CLOSE_RE.lastIndex = open.index + open[0].length;
  for (let m; (m = TEXT_CLOSE_RE.exec(xml));) close = m;
  if (!close) throw new Error('The <text> element is not closed');
  const start = open.index + open[0].length;
  const end = close.index;

  /** @type {ZoneLine[]} */
  const lines = [];
  /** @type {{label: string, chars: string[]}[]} */
  let pieces = [];
  let pending = '';
  let lineFrom = -1;
  let lineTo = -1;
  let label = OUTSIDE;
  /** @type {string|null} */
  let zoneElement = null;
  let hasText = false;

  /** @param {number} at */
  const touch = (at) => { if (lineFrom < 0) lineFrom = at; };
  /**
   * @param {string} char
   * @param {number} from
   * @param {number} to
   */
  const addChar = (char, from, to) => {
    if (IS_WS_RE.test(char)) {
      pending += char;
      return;
    }
    touch(from);
    lineTo = to;
    hasText = true;
    const last = pieces[pieces.length - 1];
    if (last && last.label === label) last.chars.push(pending + char);
    else pieces.push({ label, chars: [char] });
    pending = '';
  };
  /**
   * @param {string} text
   * @param {number} offset
   */
  const addText = (text, offset) => {
    let i = 0;
    for (const char of text) {
      addChar(char, offset + i, offset + i + char.length);
      i += char.length;
    }
  };
  /** @param {string} lbLabel */
  const endLine = (lbLabel) => {
    lines.push({
      from: lineFrom,
      to: lineTo,
      pieces: pieces.map(p => ({ label: p.label, text: collapse(p.chars.join('')) })),
      emptyLabel: lbLabel
    });
    pieces = [];
    pending = '';
    lineFrom = -1;
    lineTo = -1;
    hasText = false;
  };

  let pos = start;
  TOKEN_RE.lastIndex = start;
  for (let m; (m = TOKEN_RE.exec(xml)) && m.index < end;) {
    if (m.index + m[0].length > end) break;
    if (m.index > pos) addText(xml.slice(pos, m.index), pos);
    pos = m.index + m[0].length;
    const token = m[0];
    if (token.startsWith('&')) {
      const char = m[6] ? String.fromCodePoint(Number(m[6])) : m[7] ? String.fromCodePoint(parseInt(m[7], 16)) : (NAMED[/** @type {string} */ (m[8])] ?? token);
      addChar(char, m.index, pos);
    } else if (m[1] !== undefined) {
      addText(m[1], m.index + '<![CDATA['.length);
    } else if (token.startsWith('<!--') || token.startsWith('<?')) {
      // comments and processing instructions are not part of the text
    } else {
      const name = /** @type {string} */ (m[3]);
      const isClose = Boolean(m[2]);
      const isSelf = Boolean(m[5]);
      if (localName(name) === 'lb') {
        if (isClose) continue;
        if (!isSelf) throw new Error('<lb> must be an empty element');
        touch(m.index);
        lineTo = pos;
        endLine(label);
        continue;
      }
      if (localName(name) === 'pb') {
        // page breaks carry no text
        if (isClose) continue;
        if (!isSelf) throw new Error('<pb> must be an empty element');
        continue;
      }
      if (zoneElement === null && !isClose) {
        label = codeOf(labels, name, m[4] ?? '');
        zoneElement = isSelf ? null : name;
        if (isSelf) label = OUTSIDE;
        continue;
      }
      if (zoneElement !== null && isClose && name === zoneElement) {
        zoneElement = null;
        label = OUTSIDE;
        continue;
      }
      throw new Error(`Unexpected <${isClose ? '/' : ''}${name}> in <text>: zones may only contain text, <lb/> and <pb/>`);
    }
  }
  if (pos < end) addText(xml.slice(pos, end), pos);
  if (hasText) endLine(label);
  return lines;
}

/**
 * The canonical form of a page: one row per line, each piece as `[label]text`, pieces separated by a space.
 * @param {ZoneLine[]} lines
 * @returns {string}
 */
export function pageCanonical(lines) {
  return lines.map(line => line.pieces.map(p => `[${p.label}]${p.text}`).join(' ')).join('\n');
}

/**
 * The pages of a zone document: consecutive lines with the same page index. Lines beyond the
 * layout belong to the last page.
 * @param {ZoneLine[]} lines
 * @param {number[]} linePages - Page index (0-based) of every line, from the layout
 * @returns {ZonePage[]}
 */
export function pagesOf(lines, linePages) {
  /** @type {{number: number, firstLine: number, endLine: number}[]} */
  const ranges = [];
  /** @type {number|null} */
  let previous = null;
  for (let i = 0; i < lines.length; i++) {
    /** @type {number} */
    const page = i < linePages.length ? /** @type {number} */ (linePages[i]) : (previous ?? 0);
    const last = ranges[ranges.length - 1];
    if (previous === null || page !== previous || !last) ranges.push({ number: page + 1, firstLine: i, endLine: i + 1 });
    else last.endLine = i + 1;
    previous = page;
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  return ranges.map(range => {
    const pageLines = lines.slice(range.firstLine, range.endLine);
    const base = sha256Hex(pageCanonical(pageLines)).slice(0, 8);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const located = pageLines.filter(l => l.from >= 0);
    return {
      ...range,
      from: located[0]?.from ?? 0,
      to: located[located.length - 1]?.to ?? 0,
      fingerprint: count === 1 ? base : `${base}.${count}`
    };
  });
}

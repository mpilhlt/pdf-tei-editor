/**
 * Core logic of unit review marking (see docs/history/2026-10-23-unit-review-marking.md).
 *
 * Reviewers mark "review units" (elements under `<text>`, selected by a simple path such as
 * `.//listBibl/bibl`) as OK or not OK. A unit is identified by a fingerprint of its canonical
 * content, so editing a unit invalidates its marks while moving or re-indenting does not. The
 * marks are stored stand-off in `TEI/standOff/listAnnotation[@type="unit-review"]`, with one
 * `annotation[@motivation="assessing"]` per reviewer.
 *
 * This module has no dependency on the application: it works on a CodeMirror `EditorState`
 * (with the XML language) and on DOM elements, so it can be unit-tested in node.
 *
 * @import { EditorState } from '@codemirror/state'
 * @import { SyntaxNode } from '@lezer/common'
 */

import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { sha256Hex } from './sha256.js';

/** Value of `listAnnotation/@type` */
export const LIST_TYPE = 'unit-review';

/** Value of `listAnnotation/@subtype`, naming the fingerprint algorithm */
export const FP_ALGORITHM = 'fp-sha256-8-v1';

/** Unit path used when the variant does not define one */
export const DEFAULT_UNIT_PATH = 'auto';

/**
 * @typedef {'ok'|'not-ok'} MarkState
 */

/**
 * A review mark of one reviewer on one unit
 * @typedef {object} Mark
 * @property {MarkState} state
 * @property {string} comment - Empty if there is none
 * @property {boolean} final - A final review (only meaningful in the `final` mode)
 */

/**
 * The marks of one reviewer
 * @typedef {object} Reviewer
 * @property {string} id - Reviewer id: the user name, or `llm-<provider>-<model>` for an LLM
 * @property {string|null} name - Display name of a reviewer without a user account (LLM)
 * @property {boolean} isLlm - True for marks set by an LLM
 * @property {string|null} when - ISO timestamp of the reviewer's last change
 * @property {Map<string, Mark>} marks - Current marks by unit fingerprint
 * @property {Map<string, Mark>} was - Marks carried over from an edited unit, by the new fingerprint
 */

/**
 * The review data stored in a document
 * @typedef {object} ReviewData
 * @property {string|null} unitPath - The unit path the fingerprints were computed with
 * @property {Map<string, Reviewer>} reviewers - By reviewer id
 */

/**
 * A review unit found in the document
 * @typedef {object} Unit
 * @property {string} fingerprint - 8 hex characters, plus `.n` for the n-th unit with identical content
 * @property {number} from - Start offset of the element
 * @property {number} to - End offset of the element
 * @property {string} name - Element name
 */

/**
 * Result of {@link findUnits}
 * @typedef {object} UnitScan
 * @property {Unit[]} units - In document order
 * @property {{from: number, to: number}[]} looseText - Non-whitespace text under `<text>` outside any unit
 * @property {boolean} complete - False if the syntax tree did not cover the whole document
 * @property {string|null} path - The unit path that was applied; for the automatic default the path it resolved to (e.g. `./listBibl/*`)
 */

/**
 * Combined result of all reviews for one unit
 * @typedef {'open'|'ok'|'not-ok'|'disputed'|'stale'} CombinedState
 */

/**
 * @typedef {object} CombinedUnit
 * @property {CombinedState} state
 * @property {{reviewer: Reviewer, mark: Mark}[]} reviews - All current marks on the unit
 * @property {{reviewer: Reviewer, mark: Mark}[]} was - Marks carried over from before an edit
 * @property {{reviewer: Reviewer, mark: Mark}|null} final - The final review deciding the unit, if any
 */

/**
 * @typedef {object} ReviewSummary
 * @property {number} units
 * @property {number} ok
 * @property {number} notOk
 * @property {number} disputed
 * @property {number} open
 */

// ── Unit paths ───────────────────────────────────────────────────────

/**
 * @typedef {{descendant: boolean, name: string}} PathStep
 */

/**
 * Parses a unit path relative to `<text>`: element names (or `*`) separated by `/` (child) or
 * `//` (descendant), optionally starting with `./` or `.//`. Namespace prefixes are ignored.
 * `auto` returns null (see {@link autoUnitSteps}).
 * @param {string|null|undefined} path
 * @returns {PathStep[]|null}
 */
export function parseUnitPath(path) {
  if (!path || path === DEFAULT_UNIT_PATH) return null;
  let rest = path.trim();
  if (rest.startsWith('.')) rest = rest.slice(1);
  if (!rest.startsWith('/')) rest = '/' + rest;
  /** @type {PathStep[]} */
  const steps = [];
  const re = /(\/\/?)([^/]+)/g;
  let match;
  let consumed = 0;
  while ((match = re.exec(rest))) {
    if (match.index !== consumed) break;
    consumed = re.lastIndex;
    const name = match[2].includes(':') ? match[2].split(':').pop() : match[2];
    if (!/^(\*|[A-Za-z_][\w.-]*)$/.test(/** @type {string} */ (name))) {
      throw new Error(`Invalid unit path step "${match[2]}" in "${path}"`);
    }
    steps.push({ descendant: match[1] === '//', name: /** @type {string} */ (name) });
  }
  if (consumed !== rest.length || steps.length === 0) {
    throw new Error(`Invalid unit path "${path}"`);
  }
  return steps;
}

/**
 * Tests whether the chain of element names from below `<text>` down to an element matches the steps.
 * @param {PathStep[]} steps
 * @param {string[]} chain
 * @returns {boolean}
 */
function matchesSteps(steps, chain) {
  /**
   * @param {number} s
   * @param {number} c
   * @returns {boolean}
   */
  const match = (s, c) => {
    if (s === steps.length) return c === chain.length;
    if (c === chain.length) return false;
    const step = /** @type {PathStep} */ (steps[s]);
    const nameOk = step.name === '*' || step.name === chain[c];
    if (nameOk && match(s + 1, c + 1)) return true;
    return step.descendant && match(s, c + 1);
  };
  return match(0, 0);
}

// ── Syntax tree helpers ──────────────────────────────────────────────

/**
 * Returns the tag name of an `Element` node.
 * @param {SyntaxNode} element
 * @param {(from: number, to: number) => string} read
 * @returns {string|null}
 */
export function elementName(element, read) {
  const tag = element.getChild('OpenTag') ?? element.getChild('SelfClosingTag');
  const nameNode = tag?.getChild('TagName');
  if (!nameNode) return null;
  const name = read(nameNode.from, nameNode.to);
  return name.includes(':') ? /** @type {string} */ (name.split(':').pop()) : name;
}

/**
 * Returns the child elements of an `Element` node.
 * @param {SyntaxNode} element
 * @returns {SyntaxNode[]}
 */
function childElements(element) {
  return element.getChildren('Element');
}

/**
 * Finds `TEI/text` (or the first `text` element below the root).
 * @param {SyntaxNode} top - The tree's top node
 * @param {(from: number, to: number) => string} read
 * @returns {SyntaxNode|null}
 */
function findTextElement(top, read) {
  const root = top.getChild('Element');
  if (!root) return null;
  for (const child of childElements(root)) {
    if (elementName(child, read) === 'text') return child;
  }
  return null;
}

/**
 * Default units: step down from `<text>` while the element has exactly one non-empty child element
 * and no text of its own, then take that element's child elements.
 * @param {SyntaxNode} text
 * @param {(from: number, to: number) => string} read
 * @returns {{nodes: SyntaxNode[], path: string}} The units and the path they are found with
 */
function autoUnits(text, read) {
  /** @param {SyntaxNode} node */
  const hasOwnText = node => node.getChildren('Text').some(t => read(t.from, t.to).trim() !== '');
  /** @param {SyntaxNode} node */
  const isEmpty = node => childElements(node).length === 0 && !hasOwnText(node);
  let current = text;
  /** @type {string[]} */
  const chain = [];
  for (;;) {
    const children = childElements(current);
    // empty elements such as <front/> or <body/> in a reference list do not count
    const filled = children.filter(child => !isEmpty(child));
    const only = filled.length === 1 ? /** @type {SyntaxNode} */ (filled[0]) : null;
    if (only && !hasOwnText(current) && childElements(only).length > 0) {
      current = only;
      chain.push(elementName(current, read) ?? '*');
    } else {
      return { nodes: children, path: ['.', ...chain, '*'].join('/') };
    }
  }
}

// ── Canonical form and fingerprints ──────────────────────────────────

/**
 * Collapses whitespace runs to one space and trims.
 * @param {string} text
 * @returns {string}
 */
function normalizeSpace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Serializes an element in canonical form: tag names, attributes sorted by name, text with
 * whitespace collapsed and trimmed per text run, comments and processing instructions left out.
 * Pretty-printing and re-indenting do not change it; changes to text, markup or attributes do.
 * @param {SyntaxNode} element
 * @param {(from: number, to: number) => string} read
 * @returns {string}
 */
export function canonicalForm(element, read) {
  const tag = element.getChild('OpenTag') ?? element.getChild('SelfClosingTag');
  const name = elementName(element, read) ?? '?';
  /** @type {[string, string][]} */
  const attributes = [];
  for (const attr of tag?.getChildren('Attribute') ?? []) {
    const attrName = attr.getChild('AttributeName');
    const attrValue = attr.getChild('AttributeValue');
    if (!attrName) continue;
    const raw = attrValue ? read(attrValue.from, attrValue.to) : '';
    attributes.push([read(attrName.from, attrName.to), raw.replace(/^["']|["']$/g, '')]);
  }
  attributes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let out = '<' + name + attributes.map(([n, v]) => ` ${n}="${normalizeSpace(v)}"`).join('') + '>';
  let textRun = '';
  const flush = () => {
    const normalized = normalizeSpace(textRun);
    if (normalized) out += normalized;
    textRun = '';
  };
  for (let child = element.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
      case 'Element':
        flush();
        out += canonicalForm(child, read);
        break;
      case 'Text':
      case 'EntityReference':
      case 'CharacterReference':
        textRun += read(child.from, child.to);
        break;
      case 'Cdata':
        textRun += read(child.from, child.to).replace(/^<!\[CDATA\[|\]\]>$/g, '');
        break;
      default:
        // tags, comments, processing instructions, error nodes
        break;
    }
  }
  flush();
  return out + '</' + name + '>';
}

/**
 * Returns the fingerprint of a canonical form, without the duplicate suffix.
 * @param {string} canonical
 * @returns {string}
 */
export function fingerprintOf(canonical) {
  return sha256Hex(canonical).slice(0, 8);
}

/**
 * Finds the review units of a document.
 * @param {EditorState} state - An editor state with the XML language
 * @param {string|null} unitPath - See {@link parseUnitPath}; null or `auto` for the default
 * @param {Map<string, string>} [cache] - Fingerprint cache by raw element text, reused across calls
 * @returns {UnitScan}
 */
export function findUnits(state, unitPath, cache) {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const complete = tree.length >= state.doc.length;
  /** @param {number} from @param {number} to */
  const read = (from, to) => state.doc.sliceString(from, to);
  /** @type {UnitScan} */
  const scan = { units: [], looseText: [], complete, path: null };
  const text = findTextElement(tree.topNode, read);
  if (!text) return scan;

  const steps = parseUnitPath(unitPath);
  /** @type {SyntaxNode[]} */
  let unitNodes;
  if (steps) {
    unitNodes = [];
    /**
     * @param {SyntaxNode} element
     * @param {string[]} chain
     */
    const walk = (element, chain) => {
      for (const child of childElements(element)) {
        const childChain = [...chain, elementName(child, read) ?? ''];
        if (matchesSteps(steps, childChain)) {
          unitNodes.push(child);
        } else {
          walk(child, childChain);
        }
      }
    };
    walk(text, []);
    scan.path = unitPath ?? null;
  } else {
    const auto = autoUnits(text, read);
    unitNodes = auto.nodes;
    scan.path = auto.path;
  }

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const node of unitNodes) {
    const raw = read(node.from, node.to);
    let base = cache?.get(raw);
    if (!base) {
      base = fingerprintOf(canonicalForm(node, read));
      cache?.set(raw, base);
    }
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    scan.units.push({
      fingerprint: count === 1 ? base : `${base}.${count}`,
      from: node.from,
      to: node.to,
      name: elementName(node, read) ?? ''
    });
  }

  // text under <text> that belongs to no unit
  const unitRanges = scan.units;
  let u = 0;
  tree.iterate({
    from: text.from,
    to: text.to,
    enter: node => {
      while (u < unitRanges.length && /** @type {Unit} */ (unitRanges[u]).to <= node.from) u++;
      const unit = unitRanges[u];
      if (unit && node.from >= unit.from && node.to <= unit.to) return false;
      if (node.name === 'Text' && read(node.from, node.to).trim() !== '') {
        scan.looseText.push({ from: node.from, to: node.to });
      }
      return undefined;
    }
  });
  return scan;
}

// ── Review data in TEI ───────────────────────────────────────────────

/**
 * Returns an empty review data object.
 * @param {string|null} [unitPath]
 * @returns {ReviewData}
 */
export function emptyReviewData(unitPath = null) {
  return { unitPath, reviewers: new Map() };
}

/**
 * Returns the direct child elements of `parent` with the given local name.
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element[]}
 */
function childrenByName(parent, localName) {
  return Array.from(parent.children).filter(el => el.localName === localName);
}

/**
 * Splits a whitespace-separated fingerprint list.
 * @param {string|null} text
 * @returns {string[]}
 */
function splitList(text) {
  return (text ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Reads the review data from a `listAnnotation[@type="unit-review"]` element.
 * @param {Element|null} listAnnotation
 * @returns {ReviewData}
 */
export function readReviewData(listAnnotation) {
  const data = emptyReviewData();
  if (!listAnnotation) return data;
  for (const note of childrenByName(listAnnotation, 'note')) {
    if (note.getAttribute('type') === 'unit-xpath') data.unitPath = (note.textContent ?? '').trim() || null;
  }
  for (const annotation of childrenByName(listAnnotation, 'annotation')) {
    const xmlId = annotation.getAttribute('xml:id') ?? annotation.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id') ?? '';
    const resp = annotation.getAttribute('resp');
    const respStmt = childrenByName(annotation, 'respStmt')[0];
    const softwareName = respStmt ? childrenByName(respStmt, 'name')[0]?.textContent?.trim() ?? null : null;
    const id = resp ? resp.replace(/^#/, '') : xmlId.replace(/^ur-/, '');
    if (!id) continue;
    const change = childrenByName(annotation, 'revisionDesc')[0];
    const when = change ? childrenByName(change, 'change')[0]?.getAttribute('when') ?? null : null;
    /** @type {Reviewer} */
    const reviewer = {
      id, name: softwareName, isLlm: !resp && id.startsWith('llm-'), when, marks: new Map(), was: new Map()
    };
    for (const note of childrenByName(annotation, 'note')) {
      const type = note.getAttribute('type') ?? '';
      const match = /^(was-|final-)?(ok|not-ok)$/.exec(type);
      if (!match) continue;
      const state = /** @type {MarkState} */ (match[2]);
      const target = match[1] === 'was-' ? reviewer.was : reviewer.marks;
      const final = match[1] === 'final-';
      const n = note.getAttribute('n');
      if (n) {
        target.set(n, { state, comment: (note.textContent ?? '').trim(), final });
      } else {
        for (const fp of splitList(note.textContent)) target.set(fp, { state, comment: '', final });
      }
    }
    data.reviewers.set(id, reviewer);
  }
  return data;
}

/**
 * Escapes text for XML content and attribute values.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Turns a reviewer id into an NCName usable in `xml:id`.
 * @param {string} id
 * @returns {string}
 */
export function reviewerXmlId(id) {
  return 'ur-' + id.replace(/[^\w.-]/g, '-');
}

/**
 * Serializes the review data as a `listAnnotation[@type="unit-review"]` element. Reviewers without
 * marks are left out.
 * @param {ReviewData} data
 * @param {ReviewSummary} summary
 * @param {string} [indent] - Indentation of the `listAnnotation` element itself
 * @param {string} [unit] - One indentation level
 * @returns {string}
 */
export function serializeReviewData(data, summary, indent = '    ', unit = '  ') {
  const i1 = indent + unit, i2 = i1 + unit;
  const lines = [`${indent}<listAnnotation type="${LIST_TYPE}" subtype="${FP_ALGORITHM}">`];
  if (data.unitPath) lines.push(`${i1}<note type="unit-xpath">${escapeXml(data.unitPath)}</note>`);
  lines.push(`${i1}<note type="summary">units=${summary.units} ok=${summary.ok} not-ok=${summary.notOk} disputed=${summary.disputed} open=${summary.open}</note>`);
  const reviewers = [...data.reviewers.values()]
    .filter(r => r.marks.size || r.was.size)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const reviewer of reviewers) {
    const resp = reviewer.isLlm ? '' : ` resp="#${escapeXml(reviewer.id)}"`;
    lines.push(`${i1}<annotation xml:id="${reviewerXmlId(reviewer.id)}" motivation="assessing" target="#xpath(//text)"${resp}>`);
    if (reviewer.isLlm) {
      lines.push(`${i2}<respStmt><resp>LLM Reviewer</resp><name type="software">${escapeXml(reviewer.name ?? reviewer.id)}</name></respStmt>`);
    }
    if (reviewer.when) {
      lines.push(`${i2}<revisionDesc><change when="${escapeXml(reviewer.when)}"/></revisionDesc>`);
    }
    for (const [prefix, map] of /** @type {[string, Map<string, Mark>][]} */ ([['', reviewer.marks], ['was-', reviewer.was]])) {
      for (const final of prefix ? [false] : [false, true]) {
        const typePrefix = prefix || (final ? 'final-' : '');
        const entries = [...map.entries()].filter(([, m]) => (prefix ? true : m.final === final));
        const okList = entries.filter(([, m]) => m.state === 'ok' && !m.comment).map(([fp]) => fp);
        if (okList.length) lines.push(`${i2}<note type="${typePrefix}ok">${okList.join(' ')}</note>`);
        for (const [fp, mark] of entries) {
          if (mark.state === 'ok' && !mark.comment) continue;
          const type = `${typePrefix}${mark.state}`;
          lines.push(mark.comment
            ? `${i2}<note type="${type}" n="${escapeXml(fp)}">${escapeXml(mark.comment)}</note>`
            : `${i2}<note type="${type}" n="${escapeXml(fp)}"/>`);
        }
      }
    }
    lines.push(`${i1}</annotation>`);
  }
  lines.push(`${indent}</listAnnotation>`);
  return lines.join('\n');
}

/**
 * Removes the unit review data (and a `standOff` left empty) from a TEI document.
 * @param {Document} xmlDoc
 * @returns {boolean} True if something was removed
 */
export function removeUnitReviews(xmlDoc) {
  let removed = false;
  for (const standOff of Array.from(xmlDoc.getElementsByTagNameNS('*', 'standOff'))) {
    for (const list of childrenByName(standOff, 'listAnnotation')) {
      if (list.getAttribute('type') === LIST_TYPE) {
        list.remove();
        removed = true;
      }
    }
    if (standOff.children.length === 0) {
      // drop the whitespace before it as well
      const prev = standOff.previousSibling;
      if (prev && prev.nodeType === 3 && !(prev.textContent ?? '').trim()) prev.remove();
      standOff.remove();
    }
  }
  return removed;
}

// ── Combining reviews ────────────────────────────────────────────────

/**
 * Options for {@link combineReviews}
 * @typedef {object} CombineOptions
 * @property {'majority'|'final'} mode - `final`: a final review overrides all votes
 * @property {boolean} llmVote - Whether LLM marks count as votes; otherwise they only decide units no person has reviewed
 */

/**
 * Combines the marks of all reviewers for each unit.
 * @param {Unit[]} units
 * @param {ReviewData} data
 * @param {CombineOptions} options
 * @returns {{byFingerprint: Map<string, CombinedUnit>, summary: ReviewSummary}}
 */
export function combineReviews(units, data, options) {
  /** @type {Map<string, CombinedUnit>} */
  const byFingerprint = new Map();
  /** @type {ReviewSummary} */
  const summary = { units: units.length, ok: 0, notOk: 0, disputed: 0, open: 0 };
  const reviewers = [...data.reviewers.values()];
  for (const unit of units) {
    const fp = unit.fingerprint;
    /** @type {CombinedUnit} */
    const combined = { state: 'open', reviews: [], was: [], final: null };
    for (const reviewer of reviewers) {
      const mark = reviewer.marks.get(fp);
      if (mark) combined.reviews.push({ reviewer, mark });
      const was = reviewer.was.get(fp);
      if (was) combined.was.push({ reviewer, mark: was });
    }
    if (options.mode === 'final') {
      combined.final = combined.reviews.find(r => r.mark.final && !r.reviewer.isLlm) ?? null;
    }
    if (combined.final) {
      combined.state = combined.final.mark.state;
    } else {
      const voting = combined.reviews.filter(r => options.llmVote || !r.reviewer.isLlm);
      const counted = voting.length ? voting : combined.reviews;
      const ok = counted.filter(r => r.mark.state === 'ok').length;
      const notOk = counted.length - ok;
      if (notOk > ok) combined.state = 'not-ok';
      else if (ok > notOk) combined.state = 'ok';
      else if (ok > 0) combined.state = 'disputed';
      else combined.state = combined.was.length ? 'stale' : 'open';
    }
    switch (combined.state) {
      case 'ok': summary.ok++; break;
      case 'not-ok': summary.notOk++; break;
      case 'disputed': summary.disputed++; break;
      default: summary.open++;
    }
    byFingerprint.set(fp, combined);
  }
  return { byFingerprint, summary };
}

/**
 * Sets (or with `state` null removes) a reviewer's mark on a unit. Setting a final review removes
 * the final flag from other reviewers' marks on that unit, so there is at most one. A new mark
 * replaces carried-over (`was-`) marks of all reviewers on that unit.
 * @param {ReviewData} data
 * @param {{id: string, name?: string|null, isLlm?: boolean}} who
 * @param {string} fingerprint
 * @param {MarkState|null} state
 * @param {{comment?: string, final?: boolean, when?: string}} [options]
 */
export function setMark(data, who, fingerprint, state, options = {}) {
  let reviewer = data.reviewers.get(who.id);
  if (!reviewer) {
    reviewer = {
      id: who.id, name: who.name ?? null, isLlm: Boolean(who.isLlm), when: null, marks: new Map(), was: new Map()
    };
    data.reviewers.set(who.id, reviewer);
  }
  if (who.name) reviewer.name = who.name;
  reviewer.when = options.when ?? new Date().toISOString();
  if (state === null) {
    reviewer.marks.delete(fingerprint);
    return;
  }
  const final = Boolean(options.final);
  if (final) {
    for (const other of data.reviewers.values()) {
      const mark = other.marks.get(fingerprint);
      if (other !== reviewer && mark?.final) mark.final = false;
    }
  }
  reviewer.marks.set(fingerprint, { state, comment: (options.comment ?? '').trim(), final });
  for (const other of data.reviewers.values()) other.was.delete(fingerprint);
}

/**
 * Carries marks over from edited units to their new fingerprints as `was-` marks and drops
 * marks whose unit no longer exists and was not carried over.
 * @param {ReviewData} data
 * @param {Unit[]} units - The current units
 * @param {Map<string, string>} carry - Old fingerprint by new fingerprint, for units edited in the editor
 * @returns {boolean} True if the data changed
 */
export function reconcileReviewData(data, units, carry) {
  const current = new Set(units.map(u => u.fingerprint));
  const carriedFrom = new Set(carry.values());
  let changed = false;
  for (const reviewer of data.reviewers.values()) {
    for (const [newFp, oldFp] of carry) {
      if (!current.has(newFp)) continue;
      if (reviewer.marks.has(newFp)) continue;
      const mark = reviewer.marks.get(oldFp) ?? reviewer.was.get(oldFp);
      const existing = reviewer.was.get(newFp);
      if (mark && (!existing || existing.state !== mark.state || existing.comment !== mark.comment)) {
        reviewer.was.set(newFp, { state: mark.state, comment: mark.comment, final: false });
        changed = true;
      }
    }
    // marks on units that are gone, unless an edit in this session may still be undone
    for (const map of [reviewer.marks, reviewer.was]) {
      for (const fp of [...map.keys()]) {
        if (!current.has(fp) && !carriedFrom.has(fp)) {
          map.delete(fp);
          changed = true;
        }
      }
    }
  }
  for (const [id, reviewer] of data.reviewers) {
    if (!reviewer.marks.size && !reviewer.was.size) {
      data.reviewers.delete(id);
      changed = true;
    }
  }
  return changed;
}

/**
 * Parses a summary note (`units=184 ok=112 not-ok=8 disputed=1 open=63`).
 * @param {string} text
 * @returns {ReviewSummary|null}
 */
export function parseSummary(text) {
  /** @type {Record<string, number>} */
  const values = {};
  for (const [, key, value] of text.matchAll(/([\w-]+)=(\d+)/g)) values[/** @type {string} */ (key)] = Number(value);
  if (values.units === undefined) return null;
  return {
    units: values.units, ok: values.ok ?? 0, notOk: values['not-ok'] ?? 0,
    disputed: values.disputed ?? 0, open: values.open ?? 0
  };
}

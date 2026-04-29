/**
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { Diagnostic } from '@codemirror/lint'
 */

// Tokenizer matching GROBID's GrobidDefaultAnalyzer (StringTokenizer with
// TextUtilities.delimiters from grobid-core). A token is either a maximal run of
// non-delimiter non-whitespace characters, or a single non-whitespace delimiter
// character. Delimiter set = TextUtilities.fullPunctuations + whitespace.
// Characters NOT in the delimiter set (§, <, >, & etc.) attach to adjacent chars,
// producing tokens like §2, <www, uk>.
//
// fullPunctuations (verbatim from TextUtilities.java):
//   ( （ [ space • * , : ; ? . ! / ) ） - − – ‐
//   « » „ “ ” " ‘ ’ ' ` $ # @ ] * ♦ ♥ ♣ ♠ NBSP 。 、 ， ・
const _DELIM_CLASS =
  '(\\uff08\\[\\u2022*,:;?.!/)\\uff09\\-\\u2212\\u2013\\u2010«»' +
  '„“”"‘’\'`$#@\\]♦♥♣♠' +
  ' 。、，・ \\t\\n\\r\\f‌';
const TOKEN_RE = new RegExp(
  `[^${_DELIM_CLASS}]+|[^ \\t\\n\\r\\f ‌]`,
  'g'
);

// Matches XML character and named entity references: &amp; &#60; &#x3c;
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };

// Lookahead window for the forward-scan diff recovery.
const WINDOW = 10;

export default class GrobidSyncExtension extends FrontendExtensionPlugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'grobid-sync', deps: ['xmleditor'] });
  }

  /**
   * Cache: stable_id → feature token array, or null when the file has no
   * associated feature file (non-GROBID or cache missing).
   * @type {Map<string, string[]|null>}
   */
  #cache = new Map();

  /** @type {string|null} */
  #currentStableId = null;

  /** @param {object} state */
  async install(state) {
    await super.install(state);
    this.getDependency('xmleditor').registerLintSource(
      this.#lintSource.bind(this)
    );
    if (state.xml) {
      await this.onXmlChange(state.xml);
    }
  }

  /**
   * Fetch feature tokens whenever a new XML document is loaded.
   * Tokens are cached so subsequent edits to the same file skip the fetch.
   * @param {string|null} newStableId
   */
  async onXmlChange(newStableId) {
    this.#currentStableId = newStableId;
    if (!newStableId || this.#cache.has(newStableId)) return;
    try {
      const result = await this.callPluginApi(
        `/api/plugins/grobid/feature-tokens?stable_id=${encodeURIComponent(newStableId)}`
      );
      this.#cache.set(newStableId, result.status === 'ok' ? result.tokens : null);
    } catch (_) {
      this.#cache.set(newStableId, null);
    }
    // Force the linter to re-run now that tokens are available.
    this.getDependency('xmleditor').refreshLinting();
  }

  /**
   * CodeMirror lint source: compares cached feature tokens against the current
   * XML document and returns diagnostics for mismatches.
   * @param {import('@codemirror/view').EditorView} view
   * @returns {Diagnostic[]}
   */
  #lintSource(view) {
    const featureTokens = this.#cache.get(this.#currentStableId);
    if (!featureTokens) return [];
    const xmlText = view.state.doc.toString();
    const xmlTokens = this.#extractXmlTokens(xmlText);
    return this.#diffTokens(featureTokens, xmlTokens);
  }

  /**
   * Extract tokens from the raw XML string, restricted to the content of the
   * `<text>` element.  Each token carries its exact character offsets in the
   * raw XML so they can be used directly as CodeMirror diagnostic positions.
   *
   * Uses a simple tag-stripping state machine instead of DOMParser so that
   * offsets remain valid even when the document is not yet well-formed.
   *
   * @param {string} xmlText
   * @returns {Array<{token: string, from: number, to: number}>}
   */
  #extractXmlTokens(xmlText) {
    // Restrict to the <text> element to exclude the <teiHeader> metadata.
    const openMatch = /<text[\s>\/]/.exec(xmlText);
    if (!openMatch) return [];
    const closeIdx = xmlText.lastIndexOf('</text>');
    const slice = closeIdx !== -1
      ? xmlText.slice(openMatch.index, closeIdx)
      : xmlText.slice(openMatch.index);
    const base = openMatch.index;

    const result = [];
    let inTag = false;
    let segStart = 0;

    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === '<') {
        if (!inTag && i > segStart) {
          this.#tokenizeSegment(slice.slice(segStart, i), base + segStart, result);
        }
        inTag = true;
      } else if (slice[i] === '>') {
        inTag = false;
        segStart = i + 1;
      }
    }

    return result;
  }

  /**
   * Tokenize a text segment (between XML tags), decoding entity references so
   * that `&amp;` produces one token `&` and `&lt;www` produces one token `<www`.
   *
   * Builds a decoded string with a parallel raw-position table, then applies
   * TOKEN_RE to the decoded string so that entity chars merge correctly with
   * adjacent plain-text chars before token boundaries are computed.
   *
   * @param {string} seg - Raw XML text segment (may contain entity refs)
   * @param {number} absStart - Absolute offset of `seg[0]` in the full XML string
   * @param {Array<{token: string, from: number, to: number}>} out - Accumulator
   */
  #tokenizeSegment(seg, absStart, out) {
    // Build decoded text and a parallel table of raw XML spans.
    // rawSpans[i] = [rawFrom, rawTo] for the i-th decoded character.
    const decoded = [];
    const rawSpans = [];

    ENTITY_RE.lastIndex = 0;
    let plainAt = 0;
    let em;
    while ((em = ENTITY_RE.exec(seg)) !== null) {
      // Plain chars before this entity
      for (let i = plainAt; i < em.index; i++) {
        decoded.push(seg[i]);
        rawSpans.push([absStart + i, absStart + i + 1]);
      }
      // Decode entity; all its chars map to the full &xxx; span in the raw XML
      const rawFrom = absStart + em.index;
      const rawTo = absStart + em.index + em[0].length;
      const decodedStr = em[1] ? String.fromCodePoint(parseInt(em[1], 10))
        : em[2] ? String.fromCodePoint(parseInt(em[2], 16))
        : (NAMED_ENTITIES[em[3]] ?? em[0]);
      for (const ch of decodedStr) {
        decoded.push(ch);
        rawSpans.push([rawFrom, rawTo]);
      }
      plainAt = em.index + em[0].length;
    }
    // Remaining plain chars
    for (let i = plainAt; i < seg.length; i++) {
      decoded.push(seg[i]);
      rawSpans.push([absStart + i, absStart + i + 1]);
    }

    const decodedText = decoded.join('');
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(decodedText)) !== null) {
      const from = rawSpans[m.index][0];
      const to = rawSpans[m.index + m[0].length - 1][1];
      out.push({ token: m[0], from, to });
    }
  }

  /**
   * Forward-scan diff with a small lookahead window to recover alignment
   * after a mismatch, emitting one diagnostic per problem region.
   * @param {string[]} featureTokens
   * @param {Array<{token: string, from: number, to: number}>} xmlTokens
   * @returns {Diagnostic[]}
   */
  #diffTokens(featureTokens, xmlTokens) {
    const diagnostics = [];
    let fi = 0;
    let xi = 0;

    while (fi < featureTokens.length && xi < xmlTokens.length) {
      if (featureTokens[fi] === xmlTokens[xi].token) {
        fi++;
        xi++;
        continue;
      }

      let recovered = false;
      for (let d = 1; d <= WINDOW; d++) {
        // Missing tokens: feature list is ahead of the XML
        if (fi + d < featureTokens.length && featureTokens[fi + d] === xmlTokens[xi].token) {
          diagnostics.push({
            from: xmlTokens[xi].from,
            to: xmlTokens[xi].to,
            severity: 'warning',
            message: `Sync: ${d} token(s) missing before here (expected "${featureTokens[fi]}")`
          });
          fi += d;
          recovered = true;
          break;
        }
        // Extra tokens: XML has tokens the feature file does not
        if (xi + d < xmlTokens.length && featureTokens[fi] === xmlTokens[xi + d].token) {
          diagnostics.push({
            from: xmlTokens[xi].from,
            to: xmlTokens[xi + d - 1].to,
            severity: 'warning',
            message: `Sync: unexpected token(s) "${xmlTokens[xi].token}" (expected "${featureTokens[fi]}")`
          });
          xi += d;
          recovered = true;
          break;
        }
      }

      if (!recovered) {
        diagnostics.push({
          from: xmlTokens[xi].from,
          to: xmlTokens[xi].to,
          severity: 'error',
          message: `Sync: expected "${featureTokens[fi]}", found "${xmlTokens[xi].token}"`
        });
        fi++;
        xi++;
      }
    }

    if (xi < xmlTokens.length && fi >= featureTokens.length) {
      diagnostics.push({
        from: xmlTokens[xi].from,
        to: xmlTokens[xmlTokens.length - 1].to,
        severity: 'warning',
        message: `Sync: ${xmlTokens.length - xi} extra token(s) at end (feature file has ${featureTokens.length} tokens)`
      });
    }

    return diagnostics;
  }
}

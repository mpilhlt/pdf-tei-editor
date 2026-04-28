/**
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 * @import { Diagnostic } from '@codemirror/lint'
 */

// Tokenizer that approximates GROBID's analyzer. A token is either:
//   - An optional leading "<", one or more letters/digits (including extended Latin
//     U+00C0–U+024F), and an optional trailing ">" — this handles URL bracket
//     patterns like <www or uk> which GROBID keeps as single tokens; or
//   - Any single non-whitespace, non-word character.
const TOKEN_RE = /<?[a-zA-Z0-9À-ɏ]+>?|[^\s\w]/g;

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
   * Tokenize a single text segment (already outside XML tags), decoding entity
   * references so that `&amp;` produces one token `&` spanning the full `&amp;`
   * in the raw XML rather than three tokens `&`, `amp`, `;`.
   * @param {string} seg - Raw XML text segment (may contain entity refs)
   * @param {number} absStart - Absolute offset of `seg[0]` in the full XML string
   * @param {Array<{token: string, from: number, to: number}>} out - Accumulator
   */
  #tokenizeSegment(seg, absStart, out) {
    ENTITY_RE.lastIndex = 0;
    let plainAt = 0;
    let em;
    while ((em = ENTITY_RE.exec(seg)) !== null) {
      // Tokenize plain text before the entity reference
      if (em.index > plainAt) {
        TOKEN_RE.lastIndex = 0;
        const plain = seg.slice(plainAt, em.index);
        let tm;
        while ((tm = TOKEN_RE.exec(plain)) !== null) {
          out.push({ token: tm[0], from: absStart + plainAt + tm.index, to: absStart + plainAt + tm.index + tm[0].length });
        }
      }
      // Decode the entity and emit its token(s), spanning the full &xxx; in the raw XML
      const decoded = em[1] ? String.fromCodePoint(parseInt(em[1], 10))
        : em[2] ? String.fromCodePoint(parseInt(em[2], 16))
        : (NAMED_ENTITIES[em[3]] ?? em[0]);
      TOKEN_RE.lastIndex = 0;
      let tm;
      while ((tm = TOKEN_RE.exec(decoded)) !== null) {
        out.push({ token: tm[0], from: absStart + em.index, to: absStart + em.index + em[0].length });
      }
      plainAt = em.index + em[0].length;
    }
    // Tokenize remaining plain text after the last entity reference
    if (plainAt < seg.length) {
      TOKEN_RE.lastIndex = 0;
      const rest = seg.slice(plainAt);
      let tm;
      while ((tm = TOKEN_RE.exec(rest)) !== null) {
        out.push({ token: tm[0], from: absStart + plainAt + tm.index, to: absStart + plainAt + tm.index + tm[0].length });
      }
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

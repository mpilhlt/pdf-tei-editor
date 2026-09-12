/**
 * Utilities for pre-processing text before it is handed to a diff/merge view.
 */
import { diffTrimmedLines, diffArrays } from 'diff';

/**
 * Splits text into lines, keeping the line terminator attached to the
 * preceding line (matching how `diff`'s line-based algorithms tokenize text).
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/**
 * Returns a copy of `reference` in which lines that differ from the
 * corresponding line in `target` only by leading/trailing whitespace are
 * rewritten to match `target` exactly. Lines that differ in actual content
 * are left untouched. This lets a downstream line-based diff (e.g. CodeMirror's
 * merge view) treat whitespace-only line differences as no difference at all,
 * without ever modifying `target` itself.
 * @param {string} reference The text that will be compared against `target`
 * @param {string} target The text `reference` is diffed against
 * @returns {string} `reference`, with whitespace-only line differences resolved in favor of `target`
 */
export function ignoreLineWhitespaceInDiff(reference, target) {
  const parts = diffTrimmedLines(reference, target);
  const referenceLines = splitLines(reference);
  const targetLines = splitLines(target);
  let refIdx = 0;
  let targetIdx = 0;
  const result = [];

  for (const part of parts) {
    const count = part.count ?? 0;
    if (part.removed) {
      result.push(...referenceLines.slice(refIdx, refIdx + count));
      refIdx += count;
    } else if (part.added) {
      targetIdx += count;
    } else {
      result.push(...targetLines.slice(targetIdx, targetIdx + count));
      refIdx += count;
      targetIdx += count;
    }
  }
  return result.join('');
}

/**
 * Matches inter-element whitespace: a run of whitespace (possibly empty) found
 * strictly between a closing `>` and the next `<`, with no other content in
 * between. This is the only whitespace that is unambiguously insignificant in
 * XML regardless of its exact form, so tokenization below splits on it even
 * when empty, keeping token structure comparable between two documents whether
 * or not either one actually has whitespace at a given tag boundary.
 */
const INTER_TAG_WS = />([ \t\r\n]*)</g;

/**
 * @typedef {{type: 'chunk'|'ws', value: string}} DiffToken
 */

/**
 * Splits XML text into alternating "chunk" tokens (tag markup and element text
 * content) and "ws" tokens (whitespace found strictly between two tags).
 * @param {string} text
 * @returns {DiffToken[]}
 */
function tokenizeInterTagWhitespace(text) {
  const tokens = [];
  let lastIndex = 0;
  INTER_TAG_WS.lastIndex = 0;
  let match;
  while ((match = INTER_TAG_WS.exec(text))) {
    const wsStart = match.index + 1;
    const wsEnd = wsStart + match[1].length;
    tokens.push({ type: 'chunk', value: text.slice(lastIndex, wsStart) });
    tokens.push({ type: 'ws', value: match[1] });
    lastIndex = wsEnd;
    INTER_TAG_WS.lastIndex = wsEnd;
  }
  tokens.push({ type: 'chunk', value: text.slice(lastIndex) });
  return tokens;
}

/**
 * @param {DiffToken} a
 * @param {DiffToken} b
 * @returns {boolean}
 */
function tokensEqual(a, b) {
  if (a.type !== b.type) {
    return false;
  }
  return a.type === 'ws' ? true : a.value === b.value;
}

/**
 * Returns a copy of `reference` in which inter-tag whitespace (including
 * inserted/removed linebreaks and indentation) is rewritten to match the
 * corresponding position in `target`, as long as the surrounding tags/text are
 * otherwise identical. Whitespace inside element text content is never
 * touched, since it can be semantically significant there. `target` is never
 * modified.
 * @param {string} reference The text that will be compared against `target`
 * @param {string} target The text `reference` is diffed against
 * @returns {string} `reference`, with inter-tag whitespace differences resolved in favor of `target`
 */
export function ignoreInterTagWhitespaceInDiff(reference, target) {
  const referenceTokens = tokenizeInterTagWhitespace(reference);
  const targetTokens = tokenizeInterTagWhitespace(target);
  const parts = diffArrays(referenceTokens, targetTokens, { comparator: tokensEqual });

  const result = [];
  for (const part of parts) {
    if (part.added) {
      continue;
    }
    for (const token of part.value) {
      result.push(token.value);
    }
  }
  return result.join('');
}

/**
 * Prepares `reference` for a line-based diff against `target` by resolving XML
 * whitespace differences that carry no semantic meaning: leading/trailing
 * whitespace on any line, and inserted/removed linebreaks or indentation
 * between tags. Whitespace inside element text content is otherwise preserved,
 * since it can be significant there (e.g. in TEI prose or verse). `target` is
 * never modified.
 * @param {string} reference The text that will be compared against `target`
 * @param {string} target The text `reference` is diffed against
 * @returns {string} `reference`, with insignificant XML whitespace differences resolved in favor of `target`
 */
export function normalizeXmlWhitespaceForDiff(reference, target) {
  const interTagNormalized = ignoreInterTagWhitespaceInDiff(reference, target);
  return ignoreLineWhitespaceInDiff(interTagNormalized, target);
}

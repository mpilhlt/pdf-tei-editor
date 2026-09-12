/**
 * Utilities for pre-processing text before it is handed to a diff/merge view.
 */
import { diffTrimmedLines } from 'diff';

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

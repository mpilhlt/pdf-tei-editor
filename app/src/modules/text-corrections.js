/**
 * Helpers for the "Write text corrections to PDF" action.
 *
 * @import { TextCorrectionsPreview } from './api-client-v1.js'
 */

/**
 * Summary of a preview for the dialog
 * @typedef {object} PreviewSummary
 * @property {boolean} canApply - The corrections can be written
 * @property {boolean} needsSkip - Some differences cannot be written; the user has to confirm to skip them
 * @property {string} text - Sentence describing the preview
 */

/**
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Summarize what writing the text corrections would do.
 * @param {TextCorrectionsPreview} preview
 * @returns {PreviewSummary}
 */
export function summarizePreview(preview) {
  const unwritable = preview.unwritable?.length ?? 0
  if (preview.reason) {
    const text = unwritable
      ? `${preview.reason} ${count(unwritable, 'change')} cannot be written to the PDF.`
      : preview.reason
    return { canApply: false, needsSkip: false, text }
  }
  const corrections = preview.corrections?.length ?? 0
  let text = `${count(corrections, 'correction')} will be written to the PDF.`
  if (!corrections && preview.update_pending) {
    text = 'The corrections were written into the PDF page by page. The document will be updated for the corrected PDF in a new version.'
  } else if (preview.update_pending) {
    text += ' The document will also be updated for the corrections written page by page before.'
  }
  if (unwritable) text += ` ${count(unwritable, 'change')} cannot be written and will be skipped.`
  return { canApply: true, needsSkip: unwritable > 0, text }
}

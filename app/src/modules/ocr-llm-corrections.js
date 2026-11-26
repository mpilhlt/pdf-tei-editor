/**
 * Text for the corrections an LLM made to the text layer during an OCR run.
 *
 * @import { OcrLlmCorrection } from './api-client-v1.js'
 */

/** Maximum number of corrections listed in the OCR result */
export const MAX_LISTED_CORRECTIONS = 5

/**
 * Describe the corrections made by the LLM correction pass for the user.
 * @param {OcrLlmCorrection[]} corrections
 * @returns {string} E.g. "The language model made 7 corrections: “l” → “1”, … and 2 more"; empty if there are none
 */
export function describeLlmCorrections(corrections) {
  if (!corrections.length) return ''
  const listed = corrections.slice(0, MAX_LISTED_CORRECTIONS).map(c => `“${c.old}” → “${c.new}”`).join(', ')
  const more = corrections.length > MAX_LISTED_CORRECTIONS ? ` and ${corrections.length - MAX_LISTED_CORRECTIONS} more` : ''
  const count = corrections.length
  return `The language model made ${count} correction${count === 1 ? '' : 's'}: ${listed}${more}`
}

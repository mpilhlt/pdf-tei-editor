/**
 * Helpers of the sync prompt (plugins/sync-prompt.js): which diagnostics of the sync sources (see
 * `registerSyncSource()` in lint-utils.js) are new, and the text of the prompt.
 *
 * @import { EditorState } from '@codemirror/state'
 * @import { SyncDiagnostic } from './lint-utils.js'
 */

import { collectDiagnostics, diagnosticKey, syncSourceOptions } from './lint-utils.js'

/**
 * A diagnostic of a sync source that can be synchronized, with its key
 * @typedef {object} SyncEntry
 * @property {SyncDiagnostic & {page: number}} diagnostic
 * @property {string} key - See `diagnosticKey()` in lint-utils.js: does not depend on the position
 * @property {string} target - What it reports drift with (see `SyncSourceOptions.target`)
 */

/** What "Write text corrections to PDF" always updates */
export const TEXT_LAYER_TARGET = 'PDF text layer'

/**
 * The error and warning diagnostics of the sync sources that name a page (only those can be
 * synchronized by writing the text corrections of their pages).
 * @param {EditorState} state
 * @returns {SyncEntry[]}
 */
export function syncEntries(state) {
  /** @type {SyncEntry[]} */
  const result = []
  for (const d of /** @type {SyncDiagnostic[]} */ (collectDiagnostics(state))) {
    const options = syncSourceOptions(d.source)
    if (!options || (d.severity !== 'error' && d.severity !== 'warning') || !Number.isInteger(d.page)) continue
    result.push({ diagnostic: /** @type {SyncDiagnostic & {page: number}} */ (d), key: diagnosticKey(state, d), target: options.target })
  }
  return result
}

/**
 * The entries whose key is not in `known`.
 * @param {SyncEntry[]} entries
 * @param {Set<string>} known
 * @returns {SyncEntry[]}
 */
export function newEntries(entries, known) {
  return entries.filter(e => !known.has(e.key))
}

/**
 * The pages of the entries, sorted and without duplicates.
 * @param {SyncEntry[]} entries
 * @returns {number[]}
 */
export function pagesOf(entries) {
  return [...new Set(entries.map(e => e.diagnostic.page))].sort((a, b) => a - b)
}

/**
 * The text of the prompt, naming the PDF text layer and the targets of the entries.
 * @param {SyncEntry[]} entries
 * @returns {string}
 */
export function promptText(entries) {
  const targets = [...new Set([TEXT_LAYER_TARGET, ...entries.map(e => e.target)])].map(t => `the ${t}`)
  const list = targets.length > 1 ? `${targets.slice(0, -1).join(', ')} and ${targets[targets.length - 1]}` : targets[0]
  return `You changed the text of this document. If the changes are intentional, ${list} ${targets.length > 1 ? 'need' : 'needs'} to be updated to match.`
}

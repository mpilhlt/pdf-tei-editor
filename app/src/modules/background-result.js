/**
 * Loading the result of a process that ran in the background (text recognition, OCR correction)
 * while the user could go on working: the result is loaded at once if the user still has the
 * documents open that were shown when the process started, otherwise only after the user confirms.
 */

import { testLog } from './test-log.js'

/**
 * The documents shown when a background process started
 * @typedef {object} ShownDocuments
 * @property {string|null} pdf - stable_id of the PDF
 * @property {string|null} xml - stable_id of the XML document
 */

/**
 * @typedef {object} LoadWhenFinishedOptions
 * @property {ShownDocuments} started - The documents shown when the process started
 * @property {ShownDocuments} current - The documents shown now
 * @property {string} finishedMessage - Says which process is finished, e.g. "Text recognition is finished."
 * @property {(message: string) => Promise<boolean>} confirm - Asks the user
 * @property {() => Promise<void>} refreshFileList - Adds the result to the file selection
 * @property {() => Promise<void>} load - Loads the result
 */

/**
 * Load the result of a background process. If the user still has the documents open that were
 * shown when it started, the result is loaded at once. Otherwise the user is asked whether to load
 * it now; if not, only the file list is updated.
 * @param {LoadWhenFinishedOptions} options
 * @returns {Promise<boolean>} Whether the result was loaded
 */
export async function loadWhenFinished({ started, current, finishedMessage, confirm, refreshFileList, load }) {
  const unchanged = current.pdf === started.pdf && current.xml === started.xml
  testLog('BACKGROUND_PROCESS_FINISHED', { unchanged })
  if (!unchanged) {
    await refreshFileList()
    const confirmed = await confirm(`${finishedMessage} Load the result now?`)
    testLog('BACKGROUND_RESULT_CONFIRMED', { confirmed })
    if (!confirmed) return false
  }
  await load()
  return true
}

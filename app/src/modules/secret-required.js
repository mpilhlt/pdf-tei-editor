/**
 * Detection of the backend's "API key required" response (HTTP 428, `detail.code === 'secret_required'`).
 */

/**
 * Service information of a `secret_required` error.
 * @typedef {object} SecretRequiredDetail
 * @property {string} service - Service id
 * @property {string} label - Human-readable service name
 * @property {string=} description
 * @property {string=} help_url - Where to get a key
 */

/**
 * The service information if the error says that the user has to provide an API key.
 * @param {any} error - An error thrown by an API call
 * @returns {SecretRequiredDetail|null}
 */
export function getSecretRequired(error) {
  const detail = error?.detail
  if (error?.statusCode === 428 && detail?.code === 'secret_required' && typeof detail.service === 'string') {
    return detail
  }
  return null
}

/**
 * Run an action that may need an API key the user has not stored yet: if it fails with
 * `secret_required`, ask for the key and run the action once more.
 * @template T
 * @param {() => Promise<T>} action
 * @param {(detail: SecretRequiredDetail) => Promise<boolean>} promptForKey - Resolves true if a key was saved
 * @param {{before?: () => void, after?: () => void}=} blocker - Called around the prompt, e.g. to lift a
 *   page blocker that would cover the dialog; `after` runs even if the prompt fails or is cancelled
 * @returns {Promise<T>}
 */
export async function withKeyPrompt(action, promptForKey, blocker) {
  try {
    return await action()
  } catch (error) {
    const required = getSecretRequired(error)
    if (!required) throw error
    blocker?.before?.()
    let saved = false
    try {
      saved = await promptForKey(required)
    } finally {
      blocker?.after?.()
    }
    if (saved) return await action()
    throw error
  }
}

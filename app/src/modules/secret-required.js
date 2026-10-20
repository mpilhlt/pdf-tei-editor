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

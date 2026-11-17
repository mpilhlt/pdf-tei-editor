/**
 * Shared login code of the command line clients (batch-extract.js, manage-remote.js and the dev helpers
 * debug-api.js and benchmark-deployment.js).
 *
 * A client authenticates with a personal access token (`--token` or `API_TOKEN`), which it exchanges for a
 * session ID to send as `X-Session-ID`. Command line clients do not log in with a username and password.
 */

/**
 * Pick the access token: the command line option overrides the `API_TOKEN` environment variable.
 * @param {string=} cliToken - Value of the `--token` option
 * @returns {string|undefined} Personal access token
 */
export function resolveToken(cliToken) {
  return cliToken || process.env.API_TOKEN || undefined;
}

/**
 * Exchange a personal access token for a session.
 * @param {string} baseUrl - API base URL
 * @param {string} token - Personal access token (`pte_...`)
 * @returns {Promise<string>} Session ID
 */
export async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/v1/auth/token-login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }
  const data = await response.json();
  const sessionId = data.sessionId || data.session_id;
  if (!sessionId) {
    throw new Error(`Login response missing sessionId: ${JSON.stringify(data)}`);
  }
  return sessionId;
}

/**
 * Shared login code of the command line clients (batch-extract.js, manage-remote.js and the dev helper debug-api.js).
 *
 * A client authenticates with a personal access token (`--token` or `API_TOKEN`) if one is given,
 * otherwise with a username and password (`--user`/`--password` or `API_USER`/`API_PASSWORD`).
 * Both return a session ID to send as `X-Session-ID`.
 */

/**
 * @typedef {object} ApiCredentials
 * @property {string=} token - Personal access token (`pte_...`); preferred if set
 * @property {string=} username - Username for password login
 * @property {string=} password - Plain text password for password login
 */

/**
 * Read the session ID from a login response or throw with the server's message.
 * @param {Response} response - Response of a login endpoint
 * @returns {Promise<string>} Session ID
 */
async function sessionIdFromResponse(response) {
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

/**
 * Log in with a username and password. The password is sent in plain text, so use HTTPS for remote servers.
 * @param {string} baseUrl - API base URL
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Session ID
 */
export async function loginWithPassword(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return sessionIdFromResponse(response);
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
  return sessionIdFromResponse(response);
}

/**
 * Pick the credentials from command line options and the environment: options override environment
 * variables, and a token overrides username and password.
 * @param {{token?: string, user?: string, password?: string}} options - Command line options
 * @returns {ApiCredentials}
 */
export function resolveCredentials(options) {
  const token = options.token || process.env.API_TOKEN;
  if (token) return { token };
  return {
    username: options.user || process.env.API_USER,
    password: options.password || process.env.API_PASSWORD,
  };
}

/**
 * Log in with a token if the credentials have one, otherwise with username and password.
 * @param {string} baseUrl - API base URL
 * @param {ApiCredentials} credentials - From {@link resolveCredentials}
 * @returns {Promise<string>} Session ID
 */
export async function login(baseUrl, credentials) {
  if (credentials.token) {
    return loginWithToken(baseUrl, credentials.token);
  }
  if (!credentials.username || !credentials.password) {
    throw new Error('Provide an access token (--token or API_TOKEN) or a username and password (--user/--password or API_USER/API_PASSWORD)');
  }
  return loginWithPassword(baseUrl, credentials.username, credentials.password);
}

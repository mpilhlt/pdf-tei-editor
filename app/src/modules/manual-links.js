/**
 * Links to sections of the user manual.
 *
 * A manual link is the GitHub blob URL of a Markdown file under `docs/` in the
 * application repository, optionally with a heading anchor, e.g.
 * `https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/user-manual/access-tokens.md#using-a-token`.
 * Outside the app it opens the page on GitHub; inside the app, the info plugin
 * intercepts clicks on such links and opens the section in the user manual
 * drawer instead (whatever the ref in the URL, the manual shows the docs of the
 * running version). See docs/code-assistant/architecture-frontend.md.
 */

/** Prefix of the blob URLs of files in the application repository */
export const MANUAL_REPO_URL = 'https://github.com/mpilhlt/pdf-tei-editor'

/**
 * A manual page and section
 * @typedef {object} ManualTarget
 * @property {string} path - Path of the Markdown file relative to `docs/`, e.g. "user-manual/access-tokens.md"
 * @property {string} anchor - Heading anchor without "#", or "" for the top of the page
 */

/**
 * Parses a manual link.
 * @param {string} url - Any URL
 * @returns {ManualTarget | null} The page and section, or null if `url` is not the blob URL of a Markdown file in `docs/`
 */
export function parseManualUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.origin !== new URL(MANUAL_REPO_URL).origin) return null
  const repoPath = new URL(MANUAL_REPO_URL).pathname
  const match = parsed.pathname.match(/^(\/[^/]+\/[^/]+)\/blob\/[^/]+\/docs\/(.+\.md)$/)
  if (!match || match[1] !== repoPath) return null
  return {
    path: decodeURIComponent(match[2]),
    anchor: decodeURIComponent(parsed.hash.replace(/^#/, ''))
  }
}

/**
 * Builds a manual link.
 * @param {string} path - Path of the Markdown file relative to `docs/`
 * @param {string} [anchor] - Heading anchor without "#"
 * @param {string} [ref="main"] - Branch, tag or commit of the blob URL
 * @returns {string} The blob URL
 */
export function manualUrl(path, anchor = '', ref = 'main') {
  const cleanPath = path.replace(/^\/+/, '')
  return `${MANUAL_REPO_URL}/blob/${ref}/docs/${cleanPath}${anchor ? `#${anchor}` : ''}`
}

/** Path prefix of the standalone manual window (served by `fastapi_app/main.py`, rendered by `app/src/manual.js`) */
export const MANUAL_WINDOW_PATH = '/manual/'

/**
 * A page and section of the standalone manual window
 * @typedef {object} ManualWindowTarget
 * @property {string} path - Path of the Markdown file relative to `docs/` ("index.md" for the start page), or the
 *   virtual path `plugins/<plugin id>/<file>` of a plugin page
 * @property {string} anchor - Heading anchor without "#", or "" for the top of the page
 * @property {string} lang - Language requested with `?lang=`, or ""
 */

/**
 * Builds the URL of a page in the standalone manual window, e.g.
 * `/manual/user-manual/review-workflow#unit-review`. The path loses its `.md` extension and `index.md` is the
 * start page `/manual/`.
 * @param {string} path - Path relative to `docs/` or virtual plugin page path, with or without leading "/"
 * @param {string} [anchor] - Heading anchor without "#"
 * @param {{lang?: string, origin?: string}} [options] - `lang`: language of plugin pages; `origin`: prefix for an
 *   absolute URL, e.g. `location.origin`
 * @returns {string}
 */
export function manualWindowUrl(path, anchor = '', { lang = '', origin = '' } = {}) {
  let clean = path.replace(/^\/+/, '').replace(/\.md$/i, '')
  if (clean === 'index') clean = ''
  const encoded = clean.split('/').map(encodeURIComponent).join('/')
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  return `${origin}${MANUAL_WINDOW_PATH}${encoded}${query}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`
}

/**
 * Parses the URL of a page in the standalone manual window.
 * @param {string} url - Absolute URL, or a path starting with "/"
 * @param {string} [origin] - Origin the URL must have; any origin if omitted
 * @returns {ManualWindowTarget | null} The target, or null if `url` is not a manual window URL
 */
export function parseManualWindowUrl(url, origin) {
  let parsed
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    return null
  }
  if (origin && /^[a-z][a-z0-9+.-]*:/i.test(url) && parsed.origin !== origin) return null
  const prefix = MANUAL_WINDOW_PATH.slice(0, -1)
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(MANUAL_WINDOW_PATH)) return null
  let path = decodeURIComponent(parsed.pathname.slice(MANUAL_WINDOW_PATH.length)).replace(/\/+$/, '')
  if (!path) path = 'index'
  if (!/\.md$/i.test(path)) path = `${path}.md`
  return {
    path,
    anchor: decodeURIComponent(parsed.hash.replace(/^#/, '')),
    lang: parsed.searchParams.get('lang') || ''
  }
}

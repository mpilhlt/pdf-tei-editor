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

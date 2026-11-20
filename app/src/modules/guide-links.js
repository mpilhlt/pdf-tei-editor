/**
 * URLs of the standalone annotation guide window (`/guide/<guide id>?ref=<commit>#<heading>`, app/src/guide.js) and
 * the lookup of a guide URL (e.g. the human ref of a document's editorialDecl) among the guide files that the
 * extractors declare (`GET /api/v1/annotation-guides`). The window renders only these files; `ref` selects a commit
 * of one of them, as documents pin their guide refs to commits. See issue #879.
 */

/**
 * @import { AnnotationGuideItem } from './api-client-v1.js'
 */

/** Path prefix of the guide window */
export const GUIDE_WINDOW_PATH = '/guide/'

/** Name of the browser window the guide opens in, so that it is reused */
export const GUIDE_WINDOW_NAME = 'pte-guide'

/** Placeholder for the ref in `AnnotationGuideItem.url_template` */
const REF_PLACEHOLDER = '{ref}'

/**
 * A guide and section of the guide window
 * @typedef {object} GuideWindowTarget
 * @property {string} id - Guide id, "" for the list of guides
 * @property {string} anchor - Heading anchor without "#", or "" for the top of the guide
 * @property {string} ref - Commit of the guide file, "" for the configured branch
 */

/**
 * Whether `ref` is a commit SHA (the only refs the guide window accepts besides the configured one)
 * @param {string} ref
 * @returns {boolean}
 */
export function isCommitRef(ref) {
  return /^[0-9a-f]{7,40}$/.test(ref)
}

/**
 * Builds the URL of a guide section in the guide window.
 * @param {string} id - Guide id, "" for the list of guides
 * @param {string} [anchor] - Heading anchor without "#"
 * @param {{ref?: string, origin?: string}} [options] - `ref`: commit of the guide file; `origin`: prefix for an
 *   absolute URL, e.g. `location.origin`
 * @returns {string}
 */
export function guideWindowUrl(id, anchor = '', { ref = '', origin = '' } = {}) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  return `${origin}${GUIDE_WINDOW_PATH}${encodeURIComponent(id)}${query}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`
}

/**
 * Parses a URL of the guide window.
 * @param {string} url - Absolute URL, or a path starting with "/"
 * @returns {GuideWindowTarget | null} The target, or null if `url` is not a guide window URL
 */
export function parseGuideWindowUrl(url) {
  let parsed
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    return null
  }
  const prefix = GUIDE_WINDOW_PATH.slice(0, -1)
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(GUIDE_WINDOW_PATH)) return null
  const id = decodeURIComponent(parsed.pathname.slice(GUIDE_WINDOW_PATH.length)).replace(/\/+$/, '')
  if (id.includes('/')) return null
  return {
    id,
    anchor: decodeURIComponent(parsed.hash.replace(/^#/, '')),
    ref: parsed.searchParams.get('ref') || ''
  }
}

/**
 * Finds the guide file that a URL points to: the configured URL itself, or the same file at a commit.
 * @param {AnnotationGuideItem[]} guides
 * @param {string} url - Guide URL, optionally with "#anchor"
 * @returns {{guide: AnnotationGuideItem, ref: string, anchor: string} | null} The guide, the commit ("" for the
 *   configured URL) and the anchor ("" if none); null if no guide matches
 */
export function findGuide(guides, url) {
  const hashIndex = url.indexOf('#')
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const anchor = hashIndex === -1 ? '' : decodeURIComponent(url.slice(hashIndex + 1))
  for (const guide of guides) {
    if (guide.url === base) return { guide, ref: '', anchor }
  }
  for (const guide of guides) {
    const template = guide.url_template
    if (!template) continue
    const [before, after] = template.split(REF_PLACEHOLDER)
    if (!base.startsWith(before) || !base.endsWith(after) || base.length <= before.length + after.length) continue
    const ref = base.slice(before.length, base.length - after.length)
    if (isCommitRef(ref)) return { guide, ref, anchor }
  }
  return null
}

/**
 * The URL of a guide file at a commit.
 * @param {AnnotationGuideItem} guide
 * @param {string} ref - Commit, "" for the configured URL
 * @returns {string} The URL; the configured URL if `ref` is empty or not a commit SHA, or the URL has no template
 */
export function guideUrlAtRef(guide, ref) {
  if (!ref || !isCommitRef(ref) || !guide.url_template) return guide.url
  return guide.url_template.replace(REF_PLACEHOLDER, ref)
}

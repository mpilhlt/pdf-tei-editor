/**
 * Client-side mirror of the GitHub/GitLab blob-to-raw URL transforms in
 * fastapi_app/lib/core/git_forge_adapters.py. Deliberately duplicated
 * (rather than shared) since one runs in Python and one in the browser -
 * see docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
 * (Part F). Only the two built-in forges are mirrored here; a URL from an
 * unrecognized host is returned unchanged.
 */

/**
 * Transforms a git-forge blob/view URL into a directly-fetchable raw-text
 * URL. Returns the URL unchanged if it doesn't match a recognized GitHub or
 * GitLab blob shape, or if it isn't a well-formed absolute URL at all
 * (mirrors the Python original's graceful fallback - see
 * fastapi_app/lib/core/git_forge_adapters.py callers, which always fall
 * back to the URL as-given rather than raising).
 *
 * @param {string} url
 * @returns {string}
 */
export function blobUrlToRawUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.hostname === 'github.com') {
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (match) {
      const [, owner, repo, ref, path] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
    }
    return url;
  }

  const gitlabMarker = '/-/blob/';
  const markerIndex = parsed.pathname.indexOf(gitlabMarker);
  if (markerIndex !== -1) {
    const projectPath = parsed.pathname.slice(0, markerIndex);
    const rest = parsed.pathname.slice(markerIndex + gitlabMarker.length);
    return `${parsed.origin}${projectPath}/-/raw/${rest}`;
  }

  return url;
}

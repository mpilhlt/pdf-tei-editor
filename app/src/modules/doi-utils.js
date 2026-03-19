/**
 * DOI utility functions mirroring fastapi_app/lib/utils/doi_utils.py.
 *
 * Provides:
 * - DOI validation and normalization
 * - Filesystem-safe encoding/decoding for doc_ids
 *
 * Keep in sync with doi_utils.py.
 */

// DOI validation regex (from CrossRef specification)
// Matches: 10.{4-9 digits}/{suffix with allowed characters}
export const DOI_REGEX = /^10\.\d{4,9}\/[-._;()\/:A-Z0-9]+$/i;

const DOI_EXTRACT_PATTERN = /10\.\d{4,9}\/[-._;()\/:A-Z0-9]+/i;

const _LEGACY_ENCODING_RE = /\$([0-9A-Fa-f]{2})\$/g;


/**
 * Convert legacy $XX$ percent-style encoding to the current _xXX_ format.
 * Mirrors: normalize_legacy_encoding()
 * @param {string} s
 * @returns {string}
 */
export function normalizeLegacyEncoding(s) {
  return s.replace(_LEGACY_ENCODING_RE, (_, hex) => `_x${hex.toUpperCase()}_`)
}


/**
 * Check if a filename is already encoded.
 * Mirrors: is_filename_encoded()
 * @param {string} filename
 * @returns {boolean}
 */
export function isFilenameEncoded(filename) {
  if (!filename) return false
  if (/_x[0-9A-F]{2}_/i.test(filename)) return true
  if (/\$[0-9A-F]{2}\$/i.test(filename)) return true
  if (filename.includes('__') && /^10\.\d+__/.test(filename)) return true
  return false
}


/**
 * Encode a document ID (e.g. DOI) to a filesystem-safe filename.
 *
 * Encoding rules:
 * - Forward slashes (/) → double underscore (__)
 * - Other filesystem-incompatible characters → _xXX_ encoding
 *   where XX is the uppercase hexadecimal representation of the character code
 *
 * Mirrors: encode_filename()
 *
 * @param {string} docId - Document identifier to encode (e.g. DOI)
 * @returns {string} Filesystem-safe encoded string
 * @throws {Error} If docId is empty
 *
 * @example
 * encodeFilename("10.1111/1467-6478.00040") // "10.1111__1467-6478.00040"
 * encodeFilename("10.1234/test:file")        // "10.1234__test_x3A_file"
 * encodeFilename("doc<name>")               // "doc_x3C_name_x3E_"
 */
export function encodeFilename(docId) {
  if (!docId) throw new Error('docId cannot be empty')

  const unsafeChars = new Set(['<', '>', ':', '"', '|', '?', '*', '\\'])

  let result = docId.replace(/\//g, '__')

  return [...result].map(char => {
    if (unsafeChars.has(char) || char.charCodeAt(0) < 32) {
      return `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}_`
    }
    return char
  }).join('')
}


/**
 * Decode a filesystem-safe filename back to the original document ID.
 *
 * Reverses encodeFilename():
 * - __ → / (forward slash)
 * - _xXX_ → original character (current encoding)
 * - $XX$ → original character (legacy BC encoding)
 *
 * Mirrors: decode_filename()
 *
 * @param {string} filename - Encoded filename to decode
 * @returns {string} Original document ID string
 * @throws {Error} If filename is empty
 *
 * @example
 * decodeFilename("10.1111__1467-6478.00040")  // "10.1111/1467-6478.00040"
 * decodeFilename("10.1234__test_x3A_file")    // "10.1234/test:file"
 * decodeFilename("10.1234__test$3A$file")     // "10.1234/test:file"  (legacy BC)
 */
export function decodeFilename(filename) {
  if (!filename) throw new Error('filename cannot be empty')

  let result = filename.replace(/__/g, '/')
  result = result.replace(/_x([0-9A-F]{2})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  result = result.replace(/\$([0-9A-F]{2})\$/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  return result
}


/**
 * Convert any file identifier to a valid XML NCName for use as xml:id.
 *
 * Mirrors: encode_for_xml_id()
 *
 * @param {string} fileId - Any file identifier string
 * @returns {string} NCName-safe string suitable for use as xml:id
 *
 * @example
 * encodeForXmlId("10.5771__2699-1284-2024-3-149") // "_10.5771__2699-1284-2024-3-149"
 * encodeForXmlId("test$3A$value")                 // "test_x3A_value"
 */
export function encodeForXmlId(fileId) {
  let result = normalizeLegacyEncoding(fileId)
  result = result.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => `_x${hex.toUpperCase()}_`)
  result = result.replace(/\//g, '__')
  result = result.replace(/[^a-zA-Z0-9._\-]/g, char =>
    `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}_`
  )
  if (result && /^\d/.test(result)) result = '_' + result
  return result
}


/**
 * Decode an xml:id value back to encode_filename() format.
 *
 * Mirrors: decode_from_xml_id()
 *
 * @param {string} xmlId - xml:id value produced by encodeForXmlId
 * @returns {string} File ID in encode_filename() format
 */
export function decodeFromXmlId(xmlId) {
  if (xmlId && xmlId.length > 1 && xmlId[0] === '_' && /\d/.test(xmlId[1])) {
    return xmlId.slice(1)
  }
  return xmlId
}


/**
 * Check if a DOI string is valid according to CrossRef specifications.
 *
 * Mirrors: validate_doi()
 *
 * @param {string} doi - The DOI string to validate
 * @returns {boolean}
 *
 * @example
 * validateDoi("10.5771/2699-1284-2024-3-149") // true
 * validateDoi("not-a-doi")                    // false
 */
export function validateDoi(doi) {
  if (!doi) return false
  return DOI_REGEX.test(doi)
}


/**
 * Normalize a DOI string: strip whitespace and common URL prefixes.
 *
 * Mirrors: normalize_doi()
 *
 * @param {string} doi - DOI string to normalize
 * @returns {string} Normalized DOI string
 *
 * @example
 * normalizeDoi("  10.5771/2699-1284-2024-3-149  ")    // "10.5771/2699-1284-2024-3-149"
 * normalizeDoi("doi:10.5771/2699-1284-2024-3-149")    // "10.5771/2699-1284-2024-3-149"
 * normalizeDoi("https://doi.org/10.5771/2699-1284-2024-3-149") // "10.5771/2699-1284-2024-3-149"
 */
export function normalizeDoi(doi) {
  if (!doi) return doi
  doi = doi.trim()
  const prefixes = [
    'doi:', 'DOI:',
    'http://doi.org/', 'https://doi.org/',
    'http://dx.doi.org/', 'https://dx.doi.org/',
  ]
  for (const prefix of prefixes) {
    if (doi.startsWith(prefix)) {
      return doi.slice(prefix.length)
    }
  }
  return doi
}


/**
 * Extract a DOI from a string. Decodes filename encoding before matching,
 * so encoded doc_ids like "10.6093__2284-0184__11598" are handled correctly.
 *
 * @param {string} str - The string to extract from
 * @returns {string|null} Extracted DOI or null
 */
export function extractDoi(str) {
  if (!str) return null
  try {
    const decoded = decodeFilename(str)
    const match = decoded.match(DOI_EXTRACT_PATTERN)
    if (match) return match[0]
  } catch (_) {
    // fall through to raw match
  }
  return str.match(DOI_EXTRACT_PATTERN)?.[0] ?? null
}


// BC alias — isDoi was the original name in utils.js
export { validateDoi as isDoi }

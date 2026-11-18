/**
 * Generic language chooser based on normalized BCP 47 language codes
 * (the codes used in `xml:lang` and `langUsage/language/@ident` of the teiHeader,
 * see fastapi_app/lib/ocr/languages.py).
 *
 * @import { SlSelect, SlOption } from '../ui.js'
 */

/** @type {Intl.DisplayNames|null} */
let displayNames = null

/**
 * Names of languages that browsers do not know (mostly historical languages offered by OCR engines)
 * @type {Record<string, string>}
 */
const FALLBACK_NAMES = {
  grc: 'Ancient Greek',
  enm: 'Middle English',
  frm: 'Middle French',
  'de-Latf': 'German (Fraktur)',
  chr: 'Cherokee',
  syr: 'Syriac',
  kmr: 'Northern Kurdish',
  ceb: 'Cebuano',
  fil: 'Filipino'
}

/**
 * Return the English display name of a language code, e.g. "German" for "de" or
 * "Chinese (Simplified)" for "zh-Hans". Falls back to the code itself.
 * @param {string} code - BCP 47 language code
 * @returns {string}
 */
export function languageName(code) {
  let name = code
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' })
    name = displayNames.of(code) || code
  } catch {
    // invalid tag, use the fallback
  }
  return name === code ? (FALLBACK_NAMES[code] ?? code) : name
}

/**
 * Normalize a language code the way the backend does for the primary subtag:
 * lower-case primary subtag, title-case script, upper-case region.
 * @param {string} code
 * @returns {string}
 */
export function normalizeLanguageCode(code) {
  const [primary, ...rest] = String(code).trim().replace(/_/g, '-').split('-')
  const subtags = rest.map(subtag => {
    if (/^[A-Za-z]{4}$/.test(subtag)) return subtag[0].toUpperCase() + subtag.slice(1).toLowerCase()
    if (/^[A-Za-z]{2}$/.test(subtag)) return subtag.toUpperCase()
    return subtag
  })
  return [primary.toLowerCase(), ...subtags].join('-')
}

/**
 * Fill a select box with languages, sorted by display name, and select the given codes.
 * Codes in `value` that are not in `languages` are dropped.
 * @param {SlSelect} select - The select box; set `multiple` on it to allow several languages
 * @param {string[]} languages - Normalized language codes to offer
 * @param {string[]} [value] - Codes to select
 */
export function setLanguageOptions(select, languages, value = []) {
  select.innerHTML = ''
  const entries = languages
    .map(code => ({ code, name: languageName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const { code, name } of entries) {
    const option = /** @type {SlOption} */(document.createElement('sl-option'))
    option.value = code
    option.textContent = name === code ? code : `${name} (${code})`
    select.append(option)
  }
  const selected = value.filter(code => languages.includes(code))
  // Shoelace only accepts the value once the options have been rendered
  requestAnimationFrame(() => {
    select.value = select.multiple ? selected : (selected[0] ?? '')
  })
}

/**
 * Return the selected language codes of a select box filled by {@link setLanguageOptions}.
 * @param {SlSelect} select
 * @returns {string[]}
 */
export function getSelectedLanguages(select) {
  const value = select.value
  if (Array.isArray(value)) return value.map(String)
  return value ? [String(value)] : []
}

/**
 * Pick the codes from `candidates` that are offered, mapping a regional or script variant
 * ("en-US") to its base language ("en") if only the latter is offered.
 * @param {Array<string|null|undefined>} candidates - Language codes, e.g. from the teiHeader
 * @param {string[]} languages - Offered language codes
 * @returns {string[]}
 */
export function matchLanguages(candidates, languages) {
  /** @type {string[]} */
  const result = []
  for (const candidate of candidates) {
    if (!candidate || candidate === 'und') continue
    const code = normalizeLanguageCode(candidate)
    const match = languages.includes(code) ? code : (languages.includes(code.split('-')[0]) ? code.split('-')[0] : null)
    if (match && !result.includes(match)) result.push(match)
  }
  return result
}

/**
 * Formatting of timestamps relative to now, for lists such as the messages and the bookmarks.
 */

/**
 * Formats a timestamp relative to now ("5 minutes ago").
 * @param {string} iso
 * @returns {string}
 */
export function relativeTime(iso) {
  const time = new Date(iso).getTime()
  if (isNaN(time)) return ''
  const seconds = Math.round((time - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  /** @type {[Intl.RelativeTimeFormatUnit, number][]} */
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(seconds, 'second')
}

/**
 * `@`-mentions in comment texts (see docs/user-manual/messages.md).
 *
 * `@<id>` mentions the person whose `respStmt/persName/@xml:id` is `<id>`; for users, this is
 * the user name. The token rule is the same as in `fastapi_app/lib/messages/mentions.py`, so
 * that the editor and the message index agree on who is mentioned.
 *
 * This module has no dependency on the application, so it can be unit-tested in node.
 */

/** Source of the token rule, shared with the server */
export const MENTION_PATTERN = '(?<![\\w.@])@([A-Za-z0-9_](?:[\\w.-]*\\w)?)';

/**
 * Returns a new global regular expression for mention tokens (group 1 is the id).
 * @returns {RegExp}
 */
export function mentionRegExp() {
  return new RegExp(MENTION_PATTERN, 'g');
}

/**
 * Returns the ids of the mention tokens in a text, in order of first occurrence.
 * @param {string} text
 * @param {Set<string>|null} [known] - If given, only these ids count as mentions
 * @returns {string[]}
 */
export function findMentions(text, known = null) {
  /** @type {string[]} */
  const ids = [];
  for (const match of text.matchAll(mentionRegExp())) {
    const id = /** @type {string} */ (match[1]);
    if ((!known || known.has(id)) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * A part of a text split at mention tokens
 * @typedef {object} MentionPart
 * @property {string} text - The text, including the `@` for mentions
 * @property {string|null} id - The mentioned id, null for plain text
 */

/**
 * Splits a text into plain parts and mentions of known ids, for rendering mentions as chips.
 * @param {string} text
 * @param {Set<string>} known
 * @returns {MentionPart[]}
 */
export function splitMentions(text, known) {
  /** @type {MentionPart[]} */
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(mentionRegExp())) {
    const id = /** @type {string} */ (match[1]);
    if (!known.has(id)) continue;
    const start = /** @type {number} */ (match.index);
    if (start > last) parts.push({ text: text.slice(last, start), id: null });
    parts.push({ text: match[0], id });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), id: null });
  return parts;
}

/**
 * Returns the partial mention token that ends at a cursor position, for autocompletion.
 * @param {string} text
 * @param {number} cursor
 * @returns {{from: number, query: string}|null} Start of the token (the `@`) and the typed part of the id
 */
export function mentionQueryAt(text, cursor) {
  const before = text.slice(0, cursor);
  const match = /(?<![\w.@])@([\w.-]*)$/.exec(before);
  if (!match) return null;
  return { from: /** @type {number} */ (match.index), query: /** @type {string} */ (match[1]) };
}

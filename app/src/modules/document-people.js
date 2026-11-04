/**
 * Data model of the people involved in a document (see docs/user-manual/document-people.md):
 * the persons of `/TEI/teiHeader/fileDesc/titleStmt/respStmt`, their responsibilities, and the
 * number of revisions (`teiHeader/revisionDesc/change[@who]`) and unit comments
 * (`standOff/listAnnotation[@type="unit-comment"]`) they own.
 *
 * This module has no dependency on the application, so it can be unit-tested in node.
 *
 * @import { UserData } from '../plugins/authentication.js'
 */

import { userHasRole } from './acl-utils.js'
import { addRespStmt, getRespStmtById } from './tei-utils.js'
import { readComments, LIST_TYPE as COMMENT_LIST_TYPE } from './unit-comments.js'

const TEI_NS = 'http://www.tei-c.org/ns/1.0'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

/**
 * A responsibility that can be given to a user, and the user role it requires
 * @typedef {object} PersonRole
 * @property {'annotator'|'reviewer'|'commenter'} id
 * @property {string} resp - Text of the `resp` element, as written by the editor's plugins
 * @property {string} userRole - The role the user must have
 */

/** @type {PersonRole[]} */
export const PERSON_ROLES = [
  { id: 'annotator', resp: 'Annotator', userRole: 'annotator' },
  { id: 'reviewer', resp: 'Reviewer', userRole: 'reviewer' },
  // commenting requires only the "user" role, which every user has
  { id: 'commenter', resp: 'Commenter', userRole: 'user' }
]

/**
 * A person of the document
 * @typedef {object} DocumentPerson
 * @property {string|null} id - `persName/@xml:id` (the user name for users), null if missing
 * @property {string} name - Text of the `persName` (or `name`), or the id
 * @property {string[]} responsibilities - Texts of the `resp` elements, without repeats
 * @property {number} edits - Revisions (`change` elements) of the person in the `revisionDesc`
 * @property {number} comments - Unit comments (incl. replies) written by the person
 */

/**
 * Returns the direct child elements of `parent` with the given local name.
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element[]}
 */
function childrenByName(parent, localName) {
  return Array.from(parent.children).filter(el => el.localName === localName)
}

/**
 * Returns the `titleStmt` of `/TEI/teiHeader/fileDesc`, or null.
 * @param {Document} xmlDoc
 * @returns {Element|null}
 */
function titleStmtOf(xmlDoc) {
  const root = xmlDoc.documentElement
  if (!root) return null
  const header = childrenByName(root, 'teiHeader')[0]
  const fileDesc = header ? childrenByName(header, 'fileDesc')[0] : undefined
  return fileDesc ? childrenByName(fileDesc, 'titleStmt')[0] ?? null : null
}

/**
 * Normalizes whitespace.
 * @param {string|null} text
 * @returns {string}
 */
function normalize(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Counts the revisions per person id in the `teiHeader/revisionDesc` (`@who` may name several
 * persons, as `#id` references).
 * @param {Document} xmlDoc
 * @returns {Map<string, number>}
 */
function countEdits(xmlDoc) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  const root = xmlDoc.documentElement
  const header = root ? childrenByName(root, 'teiHeader')[0] : undefined
  for (const revisionDesc of header ? childrenByName(header, 'revisionDesc') : []) {
    for (const change of revisionDesc.getElementsByTagNameNS('*', 'change')) {
      const ids = new Set((change.getAttribute('who') ?? '').split(/\s+/).filter(Boolean).map(ref => ref.replace(/^#/, '')))
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Counts the unit comments per author.
 * @param {Document} xmlDoc
 * @returns {Map<string, number>}
 */
function countComments(xmlDoc) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  const root = xmlDoc.documentElement
  for (const standOff of root ? childrenByName(root, 'standOff') : []) {
    for (const list of childrenByName(standOff, 'listAnnotation')) {
      if (list.getAttribute('type') !== COMMENT_LIST_TYPE) continue
      for (const comment of readComments(list)) {
        if (comment.author) counts.set(comment.author, (counts.get(comment.author) ?? 0) + 1)
      }
    }
  }
  return counts
}

/**
 * Reads the persons of the document's `titleStmt/respStmt` elements. Several `respStmt`
 * elements of the same person (`persName/@xml:id`) are one entry.
 * @param {Document} xmlDoc
 * @returns {DocumentPerson[]}
 */
export function readPeople(xmlDoc) {
  const titleStmt = titleStmtOf(xmlDoc)
  if (!titleStmt) return []
  const edits = countEdits(xmlDoc)
  const comments = countComments(xmlDoc)
  /** @type {DocumentPerson[]} */
  const people = []
  for (const respStmt of childrenByName(titleStmt, 'respStmt')) {
    const resps = childrenByName(respStmt, 'resp').map(resp => normalize(resp.textContent)).filter(Boolean)
    const names = [...childrenByName(respStmt, 'persName'), ...childrenByName(respStmt, 'name'), ...childrenByName(respStmt, 'orgName')]
    for (const nameElem of names) {
      const id = nameElem.getAttributeNS(XML_NS, 'id') || nameElem.getAttribute('xml:id') || null
      const existing = id ? people.find(p => p.id === id) : undefined
      if (existing) {
        for (const resp of resps) if (!existing.responsibilities.includes(resp)) existing.responsibilities.push(resp)
        continue
      }
      people.push({
        id,
        name: normalize(nameElem.textContent) || id || '',
        responsibilities: [...new Set(resps)],
        edits: id ? edits.get(id) ?? 0 : 0,
        comments: id ? comments.get(id) ?? 0 : 0
      })
    }
  }
  return people
}

/**
 * Returns the responsibilities a user can be given: those whose role the user has.
 * @param {UserData|null} user
 * @returns {PersonRole[]}
 */
export function rolesForUser(user) {
  if (!user) return []
  return PERSON_ROLES.filter(role => role.userRole === 'user' || userHasRole(user, role.userRole))
}

/**
 * Whether the current user may add people to a document: reviewers and admins.
 * @param {UserData|null} user
 * @returns {boolean}
 */
export function canAddPeople(user) {
  return userHasRole(user, ['reviewer', 'admin'])
}

/**
 * Gives a user a responsibility in the document: adds a `resp` to the user's `respStmt`, or a new
 * `respStmt` to the `titleStmt`.
 * @param {Document} xmlDoc
 * @param {{username: string, fullname?: string}} user
 * @param {PersonRole} role
 * @returns {boolean} False if the user already has the responsibility
 * @throws {Error} If the document has no teiHeader
 */
export function addPersonRole(xmlDoc, user, role) {
  const respStmt = getRespStmtById(xmlDoc, user.username)
  if (!respStmt) {
    addRespStmt(xmlDoc, { persId: user.username, persName: user.fullname || user.username, resp: role.resp })
    return true
  }
  const resps = childrenByName(respStmt, 'resp')
  if (resps.some(resp => normalize(resp.textContent).toLowerCase() === role.resp.toLowerCase())) return false
  const resp = xmlDoc.createElementNS(respStmt.namespaceURI || TEI_NS, 'resp')
  resp.textContent = role.resp
  const last = resps[resps.length - 1]
  if (last) last.after(resp)
  else respStmt.appendChild(resp)
  return true
}

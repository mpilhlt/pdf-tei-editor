/**
 * Data model of unit comments (see docs/user-manual/unit-comments.md): comments on elements,
 * stored stand-off in `TEI/standOff/listAnnotation[@type="unit-comment"]`.
 *
 * Each comment is one `annotation`. The first comment of a thread has `@motivation="commenting"`
 * and targets the element (`#xpath(...)` plus `note[@type="fingerprint"]`); replies have
 * `@motivation="replying"` and target the thread's first comment (`#uc-...`). The thread's
 * status is the `@status` of the last `change` with one (`open` or `resolved`) in the first
 * comment's `revisionDesc`.
 *
 * This module has no dependency on the application, so it can be unit-tested in node.
 */

/** Value of `listAnnotation/@type` */
export const LIST_TYPE = 'unit-comment';

/** Value of `listAnnotation/@subtype`, naming the fingerprint algorithm (as in unit review) */
export const FP_ALGORITHM = 'fp-sha256-8-v1';

/**
 * @typedef {'open'|'resolved'} ThreadStatus
 */

/**
 * An entry of a comment's `revisionDesc`
 * @typedef {object} CommentChange
 * @property {string} who - User id
 * @property {string} when - ISO timestamp
 * @property {'open'|'resolved'|'edited'|null} status - null for the creation
 */

/**
 * One comment
 * @typedef {object} UnitComment
 * @property {string} id - `xml:id`, e.g. `uc-k3f9a2`
 * @property {string|null} replyTo - Id of the thread's first comment, null for a first comment
 * @property {string} author - User id
 * @property {string} text
 * @property {string|null} path - XPath of the commented element (first comments only)
 * @property {string|null} fingerprint - Fingerprint of the commented element (first comments only)
 * @property {CommentChange[]} changes - Creation first
 */

/**
 * A thread: a first comment and its replies
 * @typedef {object} CommentThread
 * @property {UnitComment} root
 * @property {UnitComment[]} replies - In document order
 * @property {ThreadStatus} status
 */

/**
 * Returns the direct child elements of `parent` with the given local name.
 * @param {Element} parent
 * @param {string} localName
 * @returns {Element[]}
 */
function childrenByName(parent, localName) {
  return Array.from(parent.children).filter(el => el.localName === localName);
}

/**
 * Escapes text for XML content and attribute values.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Reads the comments from a `listAnnotation[@type="unit-comment"]` element.
 * @param {Element|null} listAnnotation
 * @returns {UnitComment[]}
 */
export function readComments(listAnnotation) {
  if (!listAnnotation) return [];
  /** @type {UnitComment[]} */
  const comments = [];
  for (const annotation of childrenByName(listAnnotation, 'annotation')) {
    const id = annotation.getAttribute('xml:id') ?? annotation.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id') ?? '';
    if (!id) continue;
    const target = annotation.getAttribute('target') ?? '';
    const replying = annotation.getAttribute('motivation') === 'replying';
    const xpath = /^#xpath\((.*)\)$/.exec(target);
    const revisionDesc = childrenByName(annotation, 'revisionDesc')[0];
    /** @type {CommentChange[]} */
    const changes = (revisionDesc ? childrenByName(revisionDesc, 'change') : []).map(change => {
      const status = change.getAttribute('status');
      return {
        who: (change.getAttribute('who') ?? '').replace(/^#/, ''),
        when: change.getAttribute('when') ?? '',
        status: status === 'open' || status === 'resolved' || status === 'edited' ? status : null
      };
    });
    /** @param {string} type */
    const note = type => childrenByName(annotation, 'note').find(n => n.getAttribute('type') === type) ?? null;
    comments.push({
      id,
      replyTo: replying ? target.replace(/^#/, '') : null,
      author: (annotation.getAttribute('resp') ?? changes[0]?.who ?? '').replace(/^#/, ''),
      text: (note('comment')?.textContent ?? '').trim(),
      path: !replying && xpath ? /** @type {string} */ (xpath[1]) : null,
      fingerprint: !replying ? (note('fingerprint')?.textContent ?? '').trim() || null : null,
      changes
    });
  }
  return comments;
}

/**
 * Serializes the comments as a `listAnnotation[@type="unit-comment"]` element.
 * @param {UnitComment[]} comments
 * @param {string} [indent] - Indentation of the `listAnnotation` element itself
 * @param {string} [unit] - One indentation level
 * @returns {string}
 */
export function serializeComments(comments, indent = '    ', unit = '  ') {
  const i1 = indent + unit, i2 = i1 + unit, i3 = i2 + unit;
  const lines = [`${indent}<listAnnotation type="${LIST_TYPE}" subtype="${FP_ALGORITHM}">`];
  for (const comment of comments) {
    const target = comment.replyTo ? `#${comment.replyTo}` : `#xpath(${comment.path ?? ''})`;
    const motivation = comment.replyTo ? 'replying' : 'commenting';
    lines.push(`${i1}<annotation xml:id="${escapeXml(comment.id)}" motivation="${motivation}" target="${escapeXml(target)}" resp="#${escapeXml(comment.author)}">`);
    if (comment.changes.length) {
      lines.push(`${i2}<revisionDesc>`);
      for (const change of comment.changes) {
        const status = change.status ? ` status="${change.status}"` : '';
        lines.push(`${i3}<change when="${escapeXml(change.when)}" who="#${escapeXml(change.who)}"${status}/>`);
      }
      lines.push(`${i2}</revisionDesc>`);
    }
    if (!comment.replyTo && comment.fingerprint) lines.push(`${i2}<note type="fingerprint">${escapeXml(comment.fingerprint)}</note>`);
    lines.push(`${i2}<note type="comment">${escapeXml(comment.text)}</note>`);
    lines.push(`${i1}</annotation>`);
  }
  lines.push(`${indent}</listAnnotation>`);
  return lines.join('\n');
}

/**
 * Returns the status of a thread from its first comment's changes.
 * @param {UnitComment} root
 * @returns {ThreadStatus}
 */
export function threadStatus(root) {
  for (let i = root.changes.length - 1; i >= 0; i--) {
    const status = root.changes[i]?.status;
    if (status === 'open' || status === 'resolved') return status;
  }
  return 'open';
}

/**
 * Groups comments into threads, in the order of their first comments. Replies to a missing
 * comment are left out.
 * @param {UnitComment[]} comments
 * @returns {CommentThread[]}
 */
export function buildThreads(comments) {
  /** @type {Map<string, CommentThread>} */
  const threads = new Map();
  for (const comment of comments) {
    if (!comment.replyTo) threads.set(comment.id, { root: comment, replies: [], status: threadStatus(comment) });
  }
  for (const comment of comments) {
    if (comment.replyTo) threads.get(comment.replyTo)?.replies.push(comment);
  }
  return [...threads.values()];
}

/**
 * Returns the start of the next element with an open thread after a position, wrapping around
 * to the first one. Threads whose element was not found are skipped.
 * @param {Array<{status: ThreadStatus, from: number|null}>} threads - Status and element start of each thread
 * @param {number} head - The position to search from, usually the cursor
 * @returns {number|null} Null if there is no open thread with an element
 */
export function nextOpenThreadPosition(threads, head) {
  const open = threads
    .filter(t => t.status === 'open' && t.from !== null)
    .map(t => /** @type {number} */ (t.from))
    .sort((a, b) => a - b);
  return open.find(from => from > head) ?? open[0] ?? null;
}

/**
 * Returns a new comment id not in use.
 * @param {Iterable<string>} existing
 * @param {() => number} [random]
 * @returns {string}
 */
export function newCommentId(existing, random = Math.random) {
  const used = new Set(existing);
  for (;;) {
    const id = 'uc-' + Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    if (!used.has(id)) return id;
  }
}

/**
 * Adds a thread.
 * @param {UnitComment[]} comments
 * @param {{author: string, text: string, path: string, fingerprint: string|null, when?: string}} options
 * @returns {UnitComment} The new comment
 */
export function addThread(comments, options) {
  /** @type {UnitComment} */
  const comment = {
    id: newCommentId(comments.map(c => c.id)),
    replyTo: null,
    author: options.author,
    text: options.text,
    path: options.path,
    fingerprint: options.fingerprint,
    changes: [{ who: options.author, when: options.when ?? new Date().toISOString(), status: null }]
  };
  comments.push(comment);
  return comment;
}

/**
 * Adds a reply after the last comment of its thread. Replying to a resolved thread reopens it.
 * @param {UnitComment[]} comments
 * @param {string} threadId
 * @param {{author: string, text: string, when?: string}} options
 * @returns {UnitComment|null} The new comment, null if the thread does not exist
 */
export function addReply(comments, threadId, options) {
  const root = comments.find(c => c.id === threadId && !c.replyTo);
  if (!root) return null;
  const when = options.when ?? new Date().toISOString();
  /** @type {UnitComment} */
  const reply = {
    id: newCommentId(comments.map(c => c.id)),
    replyTo: threadId,
    author: options.author,
    text: options.text,
    path: null,
    fingerprint: null,
    changes: [{ who: options.author, when, status: null }]
  };
  let last = comments.indexOf(root);
  comments.forEach((c, i) => { if (c.replyTo === threadId) last = i; });
  comments.splice(last + 1, 0, reply);
  if (threadStatus(root) === 'resolved') root.changes.push({ who: options.author, when, status: 'open' });
  return reply;
}

/**
 * Resolves or reopens a thread.
 * @param {UnitComment[]} comments
 * @param {string} threadId
 * @param {ThreadStatus} status
 * @param {{who: string, when?: string}} options
 * @returns {boolean} True if the status changed
 */
export function setThreadStatus(comments, threadId, status, options) {
  const root = comments.find(c => c.id === threadId && !c.replyTo);
  if (!root || threadStatus(root) === status) return false;
  root.changes.push({ who: options.who, when: options.when ?? new Date().toISOString(), status });
  return true;
}

/**
 * Changes the text of a comment.
 * @param {UnitComment[]} comments
 * @param {string} id
 * @param {string} text
 * @param {{who: string, when?: string}} options
 * @returns {boolean} True if the text changed
 */
export function editComment(comments, id, text, options) {
  const comment = comments.find(c => c.id === id);
  if (!comment || comment.text === text) return false;
  comment.text = text;
  comment.changes.push({ who: options.who, when: options.when ?? new Date().toISOString(), status: 'edited' });
  return true;
}

/**
 * Deletes a comment; deleting a thread's first comment deletes the thread.
 * @param {UnitComment[]} comments
 * @param {string} id
 * @returns {UnitComment[]} The remaining comments
 */
export function deleteComment(comments, id) {
  return comments.filter(c => c.id !== id && c.replyTo !== id);
}

/**
 * Takes over into `local` (the comments of an open document) what `author` changed in `remote`
 * (the comments stored after the author saved): the author's comments are added, replaced or
 * removed, the author's status changes on other comments are added, and replies whose thread the
 * author removed go with it. Other comments of `local` stay as they are.
 * @param {UnitComment[]} local
 * @param {UnitComment[]} remote
 * @param {string} author - User id
 * @returns {{comments: UnitComment[], changed: boolean}}
 */
export function mergeAuthorComments(local, remote, author) {
  const remoteById = new Map(remote.map(c => [c.id, c]));
  const changeKey = (/** @type {CommentChange} */ c) => `${c.who}\u0000${c.when}\u0000${c.status ?? ''}`;
  let changed = false;
  /** @type {UnitComment[]} */
  const result = [];
  for (const comment of local) {
    const theirs = remoteById.get(comment.id);
    if (comment.author === author) {
      if (!theirs) {
        changed = true;
        continue;
      }
      if (JSON.stringify(theirs) !== JSON.stringify(comment)) changed = true;
      result.push(theirs);
      continue;
    }
    const known = new Set(comment.changes.map(changeKey));
    const added = (theirs?.changes ?? []).filter(c => c.who === author && !known.has(changeKey(c)));
    if (added.length) {
      changed = true;
      result.push({ ...comment, changes: [...comment.changes, ...added].sort((a, b) => a.when.localeCompare(b.when)) });
    } else {
      result.push(comment);
    }
  }
  // the author's new comments: replies at the end of their thread, threads after the comment that
  // precedes them in the stored list
  const present = new Set(result.map(c => c.id));
  remote.forEach((comment, index) => {
    if (comment.author !== author || present.has(comment.id)) return;
    let at = result.length;
    if (comment.replyTo) {
      const last = result.findLastIndex(c => c.id === comment.replyTo || c.replyTo === comment.replyTo);
      if (last === -1) return;
      at = last + 1;
    } else {
      for (let i = index - 1; i >= 0; i--) {
        const before = result.findIndex(c => c.id === remote[i]?.id);
        if (before !== -1) {
          at = before + 1;
          while (at < result.length && result[at]?.replyTo) at++;
          break;
        }
      }
    }
    result.splice(at, 0, comment);
    present.add(comment.id);
    changed = true;
  });
  const roots = new Set(result.filter(c => !c.replyTo).map(c => c.id));
  const kept = result.filter(c => !c.replyTo || roots.has(c.replyTo) || !local.some(l => l.id === c.replyTo));
  if (kept.length !== result.length) changed = true;
  return { comments: kept, changed };
}

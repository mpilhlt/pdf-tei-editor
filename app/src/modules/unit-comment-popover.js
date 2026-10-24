/**
 * Thread popover of the unit comments: the comments on an element, with a reply field and
 * buttons to resolve or reopen the thread, and to edit or delete one's own comments.
 *
 * Uses the popover mechanics of the unit review (one popover at a time, closed by Escape or a
 * click outside).
 */

import { show, el, ensureStyle, formatWhen } from './unit-review-popover.js';

/**
 * One comment as shown in the popover
 * @typedef {object} PopoverComment
 * @property {string} id
 * @property {string} who - Display name
 * @property {string|null} when - ISO timestamp
 * @property {string} text
 * @property {boolean} edited
 * @property {boolean} canEdit
 * @property {boolean} canDelete
 */

/**
 * @typedef {object} ThreadPopoverOptions
 * @property {{left: number, bottom: number}} at - Screen position (below which the popover opens)
 * @property {string} title - e.g. "Comment · line 78"
 * @property {string} subtitle - e.g. the element and the start of its text
 * @property {'open'|'resolved'} status
 * @property {string} [note] - Extra hint, e.g. that the element was not found
 * @property {PopoverComment[]} comments - The first comment, then the replies
 * @property {boolean} canWrite - Whether the user may reply and resolve
 * @property {(text: string) => void} onReply
 * @property {(status: 'open'|'resolved') => void} onStatus
 * @property {(id: string, text: string) => void} onEdit
 * @property {(id: string) => void} onDelete
 */

const STYLE_ID = 'unit-comment-popover-style';
const CSS = `
.uc-list { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow: auto; }
.uc-item { display: flex; flex-direction: column; gap: 2px; }
.uc-item + .uc-item { border-top: 1px solid var(--sl-color-neutral-200, #eee); padding-top: 8px; }
.uc-meta { color: var(--sl-color-neutral-500, #888); font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
.uc-meta b { color: var(--sl-color-neutral-800, #333); font-weight: 600; }
.uc-meta .uc-act { margin-left: auto; display: flex; gap: 6px; }
.uc-meta .uc-act button { border: 0; background: none; padding: 0; color: var(--sl-color-primary-600, #0b6bcb); cursor: pointer; font: inherit; }
.uc-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.uc-status { font-size: 11px; font-weight: 600; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; }
.uc-status-open { background: #e3effc; color: #0b6bcb; }
.uc-status-resolved { background: var(--sl-color-neutral-200, #e5e5e5); color: var(--sl-color-neutral-600, #555); }
`;

function ensureThreadStyle() {
  ensureStyle();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Creates a button.
 * @param {string} label
 * @param {string} [className]
 * @returns {HTMLButtonElement}
 */
function button(label, className) {
  const b = /** @type {HTMLButtonElement} */ (el('button', className, label));
  b.type = 'button';
  return b;
}

/**
 * Opens the thread popover.
 * @param {ThreadPopoverOptions} options
 */
export function openThreadPopover(options) {
  ensureThreadStyle();
  const root = el('div', 'ur-pop');
  root.setAttribute('role', 'dialog');
  root.dataset.testid = 'unit-comment-popover';
  const header = el('div', 'ur-pop-hd');
  header.append(
    el('b', '', options.title),
    el('span', `uc-status uc-status-${options.status}`, options.status === 'resolved' ? 'Resolved' : 'Open'),
    el('span', 'ur-sub', options.subtitle)
  );
  const body = el('div', 'ur-pop-bd');
  if (options.note) body.appendChild(el('div', 'ur-note', options.note));

  const list = el('div', 'uc-list');
  for (const comment of options.comments) {
    const item = el('div', 'uc-item');
    item.dataset.testid = 'unit-comment-item';
    const meta = el('div', 'uc-meta');
    meta.append(el('b', '', comment.who), el('span', '', formatWhen(comment.when) + (comment.edited ? ' · edited' : '')));
    const actions = el('span', 'uc-act');
    const text = el('div', 'uc-text', comment.text);
    if (comment.canEdit) {
      const edit = button('Edit');
      edit.addEventListener('click', () => {
        const input = /** @type {HTMLInputElement} */ (el('input'));
        input.type = 'text';
        input.value = comment.text;
        text.replaceWith(input);
        edit.remove();
        input.focus();
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const value = input.value.trim();
            close();
            if (value && value !== comment.text) options.onEdit(comment.id, value);
          }
        });
      });
      actions.appendChild(edit);
    }
    if (comment.canDelete) {
      const del = button('Delete');
      del.dataset.testid = 'unit-comment-delete';
      del.addEventListener('click', () => {
        close();
        options.onDelete(comment.id);
      });
      actions.appendChild(del);
    }
    meta.appendChild(actions);
    item.append(meta, text);
    list.appendChild(item);
  }
  body.appendChild(list);

  const reply = /** @type {HTMLInputElement} */ (el('input'));
  reply.type = 'text';
  reply.placeholder = 'Reply';
  reply.dataset.testid = 'unit-comment-reply';
  if (options.canWrite) body.appendChild(reply);

  const footer = el('div', 'ur-ft');
  const closeButton = button('Close');
  footer.appendChild(closeButton);
  const resolved = options.status === 'resolved';
  const statusButton = button(resolved ? 'Reopen' : 'Resolve');
  statusButton.dataset.testid = 'unit-comment-status';
  const replyButton = button('Reply', 'ur-primary');
  replyButton.dataset.testid = 'unit-comment-reply-save';
  if (options.canWrite) footer.append(statusButton, replyButton);
  root.append(header, body, footer);

  const close = show(root, options.at);
  closeButton.addEventListener('click', close);
  statusButton.addEventListener('click', () => {
    close();
    options.onStatus(resolved ? 'open' : 'resolved');
  });
  const submit = () => {
    const value = reply.value.trim();
    if (!value) return;
    close();
    options.onReply(value);
  };
  replyButton.addEventListener('click', submit);
  reply.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  (options.canWrite ? reply : closeButton).focus();
}

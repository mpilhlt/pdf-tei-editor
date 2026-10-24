/**
 * Popovers of the unit review marking: the review popover opened from the gutter strip, and the
 * small comment field shown after marking a unit "not OK" with the keyboard.
 *
 * Both are plain DOM, positioned fixed below a screen coordinate and closed by Escape, a click
 * outside, or their buttons. Only one popover is open at a time.
 */

/**
 * One review as shown in the popover
 * @typedef {object} PopoverReview
 * @property {string} who - Display name
 * @property {'ok'|'not-ok'} state
 * @property {string} comment
 * @property {string|null} when - ISO timestamp
 * @property {boolean} final
 * @property {boolean} was - True for a mark made before the unit was edited
 */

/**
 * @typedef {object} ReviewPopoverOptions
 * @property {{left: number, bottom: number}} at - Screen position (below which the popover opens)
 * @property {string} title - e.g. "Line 78"
 * @property {string} subtitle - e.g. the start of the unit's text
 * @property {'ok'|'not-ok'|null} state - The current user's mark
 * @property {string} comment - The current user's comment
 * @property {boolean} final - Whether the current user's mark is a final review
 * @property {boolean} canFinal - Whether to offer the final review checkbox
 * @property {PopoverReview[]} others - Reviews of other reviewers, and carried-over marks
 * @property {string} combined - Description of the combined result
 * @property {string} [note] - Extra hint, e.g. that several units share the line
 * @property {boolean} readOnly - Show only, no editing
 * @property {(result: {state: 'ok'|'not-ok'|null, comment: string, final: boolean}) => void} onSave
 */

/** @type {(() => void)|null} */
let closeCurrent = null;

const STYLE_ID = 'unit-review-popover-style';
const CSS = `
.ur-pop { position: fixed; z-index: 1000; background: var(--sl-color-neutral-0, #fff); color: var(--sl-color-neutral-900, #222);
  border: 1px solid var(--sl-color-neutral-300, #ccc); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.2);
  font: 13px/1.4 var(--sl-font-sans, sans-serif); width: 420px; max-width: calc(100vw - 16px); }
.ur-pop-hd { padding: 8px 12px; border-bottom: 1px solid var(--sl-color-neutral-200, #eee); display: flex; gap: 8px; align-items: baseline; }
.ur-pop-hd .ur-sub { color: var(--sl-color-neutral-500, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ur-pop-bd { padding: 10px 12px; display: flex; flex-direction: column; gap: 9px; }
.ur-row { display: flex; gap: 10px; align-items: center; }
.ur-row > .ur-label { width: 80px; flex: none; color: var(--sl-color-neutral-600, #555); }
.ur-seg { display: inline-flex; border: 1px solid var(--sl-color-neutral-400, #bbb); border-radius: 5px; overflow: hidden; }
.ur-seg button { border: 0; border-right: 1px solid var(--sl-color-neutral-400, #bbb); background: transparent; padding: 4px 10px; cursor: pointer; font: inherit; color: inherit; }
.ur-seg button:last-child { border-right: 0; }
.ur-seg button.ur-on[data-state="ok"] { background: #2f9e57; color: #fff; }
.ur-seg button.ur-on[data-state="not-ok"] { background: #d64545; color: #fff; }
.ur-seg button.ur-on[data-state=""] { background: var(--sl-color-neutral-200, #e5e5e5); }
.ur-pop input[type="text"] { flex: 1; font: inherit; padding: 5px 8px; border: 1px solid var(--sl-color-neutral-400, #bbb); border-radius: 5px; min-width: 0; }
.ur-others { border-top: 1px solid var(--sl-color-neutral-200, #eee); padding-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.ur-others .ur-h { color: var(--sl-color-neutral-500, #888); font-size: 11px; font-weight: 600; text-transform: uppercase; }
.ur-rev { display: flex; gap: 6px; font-size: 12.5px; }
.ur-rev .ur-ok { color: #2f9e57; } .ur-rev .ur-not-ok { color: #d64545; }
.ur-rev.ur-was { opacity: .7; }
.ur-combined { background: var(--sl-color-warning-50, #fff6e0); border: 1px solid var(--sl-color-warning-200, #f0d58a); border-radius: 5px; padding: 5px 8px; font-size: 12.5px; }
.ur-note { color: var(--sl-color-neutral-500, #888); font-size: 12px; }
.ur-ft { display: flex; gap: 8px; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid var(--sl-color-neutral-200, #eee); }
.ur-ft button { font: inherit; padding: 3px 12px; border-radius: 5px; border: 1px solid var(--sl-color-neutral-400, #bbb); background: var(--sl-color-neutral-0, #fff); color: inherit; cursor: pointer; }
.ur-ft button.ur-primary { background: var(--sl-color-primary-600, #0b6bcb); border-color: var(--sl-color-primary-600, #0b6bcb); color: #fff; }
.ur-prompt { width: 360px; }
.ur-prompt .ur-hint { color: var(--sl-color-neutral-500, #888); font-size: 12px; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Creates an element with a class and optional text.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * Formats an ISO timestamp as a short local date and time.
 * @param {string|null} when
 * @returns {string}
 */
export function formatWhen(when) {
  if (!when) return '';
  const date = new Date(when);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Shows `element` fixed below the given position and wires the closing behavior.
 * @param {HTMLElement} element
 * @param {{left: number, bottom: number}} at
 * @param {() => void} [onClose]
 * @returns {() => void} Closes the popover
 */
function show(element, at, onClose) {
  closePopover();
  ensureStyle();
  document.body.appendChild(element);
  const rect = element.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - rect.width - 8));
  let top = at.bottom + 4;
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;

  /** @param {MouseEvent} event */
  const onDocMouseDown = event => {
    if (!element.contains(/** @type {Node} */ (event.target))) close();
  };
  /** @param {KeyboardEvent} event */
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const close = () => {
    if (!element.isConnected) return;
    element.remove();
    document.removeEventListener('mousedown', onDocMouseDown, true);
    element.removeEventListener('keydown', onKeyDown);
    if (closeCurrent === close) closeCurrent = null;
    onClose?.();
  };
  // defer, so the click that opened the popover does not close it
  setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 0);
  element.addEventListener('keydown', onKeyDown);
  closeCurrent = close;
  return close;
}

/**
 * Closes the open popover, if any.
 */
export function closePopover() {
  closeCurrent?.();
}

/**
 * Opens the review popover.
 * @param {ReviewPopoverOptions} options
 */
export function openReviewPopover(options) {
  const root = el('div', 'ur-pop');
  root.setAttribute('role', 'dialog');
  root.dataset.testid = 'unit-review-popover';
  const header = el('div', 'ur-pop-hd');
  header.append(el('b', '', options.title), el('span', 'ur-sub', options.subtitle));
  const body = el('div', 'ur-pop-bd');

  /** @type {'ok'|'not-ok'|null} */
  let state = options.state;
  const seg = el('span', 'ur-seg');
  /** @type {[string, string][]} */
  const choices = [['', 'Unreviewed'], ['ok', '✓ OK'], ['not-ok', '✕ Not OK']];
  for (const [value, label] of choices) {
    const button = /** @type {HTMLButtonElement} */ (el('button', '', label));
    button.type = 'button';
    button.dataset.state = value;
    button.disabled = options.readOnly;
    button.addEventListener('click', () => {
      state = value ? /** @type {'ok'|'not-ok'} */ (value) : null;
      updateSeg();
    });
    seg.appendChild(button);
  }
  const updateSeg = () => {
    for (const button of /** @type {HTMLButtonElement[]} */ (Array.from(seg.children))) {
      button.classList.toggle('ur-on', button.dataset.state === (state ?? ''));
    }
  };
  updateSeg();
  const stateRow = el('div', 'ur-row');
  stateRow.append(el('span', 'ur-label', 'Your review'), seg);

  const comment = /** @type {HTMLInputElement} */ (el('input'));
  comment.type = 'text';
  comment.value = options.comment;
  comment.placeholder = 'Optional short comment';
  comment.disabled = options.readOnly;
  comment.dataset.testid = 'unit-review-comment';
  const commentRow = el('div', 'ur-row');
  commentRow.append(el('span', 'ur-label', 'Comment'), comment);
  body.append(stateRow, commentRow);

  const finalBox = /** @type {HTMLInputElement} */ (el('input'));
  finalBox.type = 'checkbox';
  finalBox.checked = options.final;
  if (options.canFinal) {
    const finalRow = el('label', 'ur-row');
    finalRow.append(el('span', 'ur-label'), finalBox, el('span', '', 'Final review (overrides all others)'));
    body.appendChild(finalRow);
  }

  if (options.others.length) {
    const others = el('div', 'ur-others');
    others.appendChild(el('div', 'ur-h', 'Other reviews'));
    for (const review of options.others) {
      const row = el('div', 'ur-rev' + (review.was ? ' ur-was' : ''));
      row.appendChild(el('span', review.state === 'ok' ? 'ur-ok' : 'ur-not-ok', review.state === 'ok' ? '✓' : '✕'));
      const text = el('span');
      const meta = [review.who, formatWhen(review.when)].filter(Boolean).join(' · ');
      text.textContent = (review.was ? 'before the last edit: ' : '') + (review.final ? 'final · ' : '') + meta;
      if (review.comment) {
        text.appendChild(document.createElement('br'));
        text.appendChild(document.createTextNode(`“${review.comment}”`));
      }
      row.appendChild(text);
      others.appendChild(row);
    }
    body.appendChild(others);
  }
  if (options.combined) body.appendChild(el('div', 'ur-combined', options.combined));
  if (options.note) body.appendChild(el('div', 'ur-note', options.note));

  const footer = el('div', 'ur-ft');
  const cancel = /** @type {HTMLButtonElement} */ (el('button', '', options.readOnly ? 'Close' : 'Cancel'));
  cancel.type = 'button';
  footer.appendChild(cancel);
  const save = /** @type {HTMLButtonElement} */ (el('button', 'ur-primary', 'Save'));
  save.type = 'button';
  save.dataset.testid = 'unit-review-save';
  if (!options.readOnly) footer.appendChild(save);
  root.append(header, body, footer);

  const close = show(root, options.at);
  cancel.addEventListener('click', close);
  const submit = () => {
    close();
    options.onSave({ state, comment: comment.value.trim(), final: options.canFinal && finalBox.checked });
  };
  save.addEventListener('click', submit);
  comment.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  (options.readOnly ? cancel : comment).focus();
}

/**
 * Opens the small comment field shown after marking a unit "not OK".
 * @param {{left: number, bottom: number}} at
 * @param {string} label - e.g. "Not OK · line 78"
 * @param {string} initial - Current comment
 * @param {(comment: string|null) => void} onDone - Called with the comment, or null if skipped
 */
export function openCommentPrompt(at, label, initial, onDone) {
  const root = el('div', 'ur-pop ur-prompt');
  root.dataset.testid = 'unit-review-comment-prompt';
  const body = el('div', 'ur-pop-bd');
  body.appendChild(el('div', '', label));
  const input = /** @type {HTMLInputElement} */ (el('input'));
  input.type = 'text';
  input.value = initial;
  input.placeholder = 'Optional short comment';
  body.appendChild(input);
  body.appendChild(el('div', 'ur-hint', 'Enter: save and go to the next unit · Esc: no comment'));
  root.appendChild(body);
  let submitted = false;
  const close = show(root, at, () => {
    if (!submitted) onDone(null);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitted = true;
      close();
      onDone(input.value.trim());
    }
  });
  input.focus();
}

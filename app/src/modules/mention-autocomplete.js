/**
 * `@`-mention support for the text fields of the unit review and unit comment popovers: an
 * autocomplete list of the document's persons, and rendering of mentions as chips.
 *
 * The stored text keeps the plain `@<id>` token (see modules/mentions.js).
 */

import { mentionQueryAt, splitMentions } from './mentions.js';
import { linkifyNodes } from './linkify.js';

/**
 * A person that can be mentioned
 * @typedef {object} MentionCandidate
 * @property {string} id - The user name (`persName/@xml:id`)
 * @property {string} name - Full name
 */

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/**
 * The persons that can be mentioned in a document: its respStmt persons and its owner. Only
 * those that are users receive messages (checked by the server), and nobody receives their own.
 * @param {Document|null} xmlDoc
 * @param {string|null} owner - User name of the document owner
 * @returns {MentionCandidate[]}
 */
export function mentionCandidates(xmlDoc, owner) {
  /** @type {Map<string, string>} */
  const candidates = new Map();
  for (const pers of xmlDoc ? Array.from(xmlDoc.getElementsByTagNameNS(TEI_NS, 'persName')) : []) {
    const id = pers.getAttribute('xml:id');
    if (id && pers.parentElement?.localName === 'respStmt' && !candidates.has(id)) candidates.set(id, pers.textContent?.trim() || id);
  }
  if (owner && !candidates.has(owner)) candidates.set(owner, owner);
  return [...candidates].map(([id, name]) => ({ id, name }));
}

const STYLE_ID = 'mention-autocomplete-style';
const CSS = `
.mention-list { position: fixed; z-index: 1001; background: var(--sl-color-neutral-0, #fff); color: var(--sl-color-neutral-900, #222);
  border: 1px solid var(--sl-color-neutral-300, #ccc); border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.18);
  font: 13px/1.4 var(--sl-font-sans, sans-serif); min-width: 200px; max-height: 220px; overflow: auto; padding: 3px 0; }
.mention-list div { padding: 3px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.mention-list div[aria-selected="true"] { background: var(--sl-color-primary-100, #e3effc); }
.mention-list small { color: var(--sl-color-neutral-500, #888); }
.mention-chip { display: inline-block; padding: 0 5px; border-radius: 9px; background: var(--sl-color-primary-100, #e3effc);
  color: var(--sl-color-primary-700, #0a58a8); font-size: .95em; white-space: nowrap; }
`;

function ensureMentionStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Adds the autocomplete list to a text input: typing `@` lists the candidates, filtered by what
 * follows; arrow keys select, Enter or Tab inserts `@<id> `, Escape closes the list.
 * @param {HTMLInputElement} input
 * @param {MentionCandidate[]} candidates
 */
export function attachMentionAutocomplete(input, candidates) {
  if (!candidates.length) return;
  ensureMentionStyle();
  /** @type {HTMLElement|null} */
  let list = null;
  /** @type {MentionCandidate[]} */
  let shown = [];
  let selected = 0;
  /** @type {{from: number, query: string}|null} */
  let token = null;

  const closeList = () => {
    list?.remove();
    list = null;
    shown = [];
  };

  /** @param {MentionCandidate} candidate */
  const insert = candidate => {
    if (!token) return;
    const cursor = input.selectionStart ?? input.value.length;
    const text = `@${candidate.id} `;
    input.value = input.value.slice(0, token.from) + text + input.value.slice(cursor);
    const at = token.from + text.length;
    input.setSelectionRange(at, at);
    closeList();
    input.focus();
  };

  const render = () => {
    if (!list) {
      list = document.createElement('div');
      list.className = 'mention-list';
      list.dataset.testid = 'mention-list';
      list.setAttribute('role', 'listbox');
      // keep the focus in the input
      list.addEventListener('mousedown', event => event.preventDefault());
      document.body.appendChild(list);
    }
    list.replaceChildren(...shown.map((candidate, i) => {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(i === selected));
      option.dataset.id = candidate.id;
      const name = document.createElement('span');
      name.textContent = candidate.name;
      const id = document.createElement('small');
      id.textContent = `@${candidate.id}`;
      option.append(name, id);
      option.addEventListener('click', () => insert(candidate));
      return option;
    }));
    const rect = input.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 2}px`;
  };

  const update = () => {
    token = mentionQueryAt(input.value, input.selectionStart ?? input.value.length);
    if (!token) return closeList();
    const query = token.query.toLowerCase();
    shown = candidates.filter(c => c.id.toLowerCase().startsWith(query) || c.name.toLowerCase().split(/\s+/).some(w => w.startsWith(query)));
    if (!shown.length) return closeList();
    selected = Math.min(selected, shown.length - 1);
    render();
  };

  input.addEventListener('input', () => { selected = 0; update(); });
  input.addEventListener('blur', () => setTimeout(closeList, 100));
  // capture phase, so that the popover's own Enter and Escape handlers do not run while the list is open
  input.addEventListener('keydown', event => {
    if (!list) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const candidate = shown[selected];
      if (candidate) insert(candidate);
    } else if (event.key === 'Escape') {
      closeList();
    } else {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  // the input is removed with its popover
  new MutationObserver((_, observer) => {
    if (!input.isConnected) {
      closeList();
      observer.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/**
 * Fills an element with a text in which the mentions of known persons are chips with their name
 * and http(s) URLs are links opening in a new tab. URLs are split off first, so that an `@` in a
 * URL is not taken as a mention.
 * @param {HTMLElement} element
 * @param {string} text
 * @param {Map<string, string>} names - Full name by id
 */
export function renderWithMentions(element, text, names) {
  ensureMentionStyle();
  const known = new Set(names.keys());
  element.replaceChildren(...linkifyNodes(text, plain => splitMentions(plain, known).map(part => {
    if (!part.id) return document.createTextNode(part.text);
    const chip = document.createElement('span');
    chip.className = 'mention-chip';
    chip.textContent = names.get(part.id) ?? part.text;
    chip.title = part.text;
    return chip;
  })));
}

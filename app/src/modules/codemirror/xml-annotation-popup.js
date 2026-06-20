/**
 * Properties popup for XML annotation badges.
 *
 * Triggered by the `ann-badge-click` custom event bubbled from badge widgets.
 * Shows the annotation tag's editable attributes and a "Remove annotation" link.
 *
 * @import { XMLEditor } from '../xmleditor.js'
 */

import { resolveLabel } from './xml-annotation-decorations.js';

/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null, color: string,
 *   attributes?: Array<{ name: string, values?: string[]|null }>|null,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null }} AnnotationTagDef
 */

/**
 * Merges `element` into its nearest preceding element sibling: element's children and all
 * nodes that sit between the sibling and element (text nodes, etc.) are appended in order to
 * the end of the sibling.  If no preceding element sibling exists, element is unwrapped
 * in-place (its children replace it in the parent).
 * @param {Element} element
 * @returns {Node} the parent node that must be re-synced to the editor
 */
export function mergeWithPrev(element) {
  const parent = /** @type {Node} */ (element.parentNode);
  const prev = element.previousElementSibling;
  if (prev) {
    const frag = document.createDocumentFragment();
    let n = prev.nextSibling;
    while (n && n !== element) {
      const next = n.nextSibling;
      frag.appendChild(n);
      n = next;
    }
    while (element.firstChild) frag.appendChild(element.firstChild);
    prev.appendChild(frag);
  } else {
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
  return parent;
}

/**
 * Merges `element` into its nearest following element sibling: element's children and all
 * nodes that sit between element and the sibling (text nodes, etc.) are prepended in order to
 * the beginning of the sibling.  If no following element sibling exists, element is unwrapped
 * in-place.
 * @param {Element} element
 * @returns {Node} the parent node that must be re-synced to the editor
 */
export function mergeWithNext(element) {
  const parent = /** @type {Node} */ (element.parentNode);
  const next = element.nextElementSibling;
  if (next) {
    const frag = document.createDocumentFragment();
    while (element.firstChild) frag.appendChild(element.firstChild);
    let n = element.nextSibling;
    while (n && n !== next) {
      const after = n.nextSibling;
      frag.appendChild(n);
      n = after;
    }
    next.insertBefore(frag, next.firstChild);
  } else {
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
  return parent;
}

export class XmlAnnotationPopup {
  /** @param {XMLEditor} editor */
  constructor(editor) {
    this.#editor = editor;
  }

  /** @type {XMLEditor} */
  #editor;

  /** @type {HTMLElement|null} */
  #overlay = null;

  /** @type {AnnotationTagDef[]} */
  #tagDefs = [];

  /** @type {Map<string, AnnotationTagDef[]>} */
  #tagMap = new Map();

  /** @type {((def: AnnotationTagDef) => void)|null} */
  #wrapCallback = null;

  /**
   * Mount the popup overlay into the editor container.
   * Call once from the annotation plugin's install().
   * @param {HTMLElement} parent
   * @param {AnnotationTagDef[]} tagDefs
   */
  mount(parent, tagDefs) {
    this.#buildTagMap(tagDefs);

    const overlay = document.createElement('div');
    overlay.className = 'ann-popup';
    overlay.style.cssText = 'display:none; position:fixed; z-index:10000; background:#313244; border:1px solid #45475a; border-radius:6px; padding:12px 16px; font-size:12px; font-family:monospace; color:#cdd6f4; box-shadow:0 4px 16px rgba(0,0,0,.4); min-width:180px;';
    parent.appendChild(overlay);
    this.#overlay = overlay;

    parent.addEventListener('ann-badge-click', (e) => {
      const { tag, from, clientX = 0, clientY = 0 } = /** @type {CustomEvent} */ (e).detail;
      const defs = this.#tagMap.get(tag);
      if (!defs) return;
      let element;
      try { element = /** @type {Element} */ (this.#editor.getDomNodeAt(from)); } catch { return; }
      if (!element) return;
      const def = this.#selectDef(defs, element);
      if (!def) return;
      this.#show({ clientX, clientY }, def, element);
    });

    document.addEventListener('click', (e) => {
      if (this.#overlay && !this.#overlay.contains(/** @type {Node} */ (e.target))) {
        this.#hide();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.#hide(); });
  }

  /**
   * Update the tag map when tag definitions change (variant switch).
   * @param {AnnotationTagDef[]} tagDefs
   */
  updateTagDefs(tagDefs) {
    this.#buildTagMap(tagDefs);
    this.#hide();
  }

  /**
   * Register the callback invoked when the user picks a chip in the selection popup.
   * Must be called once from the annotation plugin after `mount()`.
   * @param {(def: AnnotationTagDef) => void} fn
   */
  setWrapCallback(fn) {
    this.#wrapCallback = fn;
  }

  /**
   * Show the "Annotate as…" palette popup at the given screen coordinates.
   * Called by the annotation plugin's mouseup handler when annotation mode is active
   * and the user has a non-empty CM selection.
   * @param {{ clientX: number, clientY: number }} coords
   * @param {number} _from  CM document position of selection start (reserved for future use)
   * @param {number} _to    CM document position of selection end
   */
  showForSelection(coords, _from, _to) {
    if (!this.#overlay) return;
    this.#overlay.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; margin-bottom:10px; font-size:11px; letter-spacing:.05em;';
    title.textContent = 'Annotate as…';
    this.#overlay.appendChild(title);

    this.#renderPalette(this.#overlay, null, (def) => {
      this.#hide();
      this.#wrapCallback?.(def);
    });

    const x = coords.clientX;
    const y = coords.clientY;
    this.#overlay.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    this.#overlay.style.top  = `${Math.min(y + 12, window.innerHeight - 200)}px`;
    this.#overlay.style.display = '';
  }

  // ── Private ────────────────────────────────────────────────────────

  /** @param {AnnotationTagDef[]} tagDefs */
  #buildTagMap(tagDefs) {
    this.#tagDefs = tagDefs;
    this.#tagMap = new Map();
    for (const d of tagDefs) {
      const bucket = this.#tagMap.get(d.tag);
      if (bucket) bucket.push(d);
      else this.#tagMap.set(d.tag, [d]);
    }
  }

  /**
   * Picks the best-matching def for `element` from a bucket of defs for the same tag name.
   * Prefers a def whose `defaultAttributes` all match the element's attributes; falls back to
   * the first def with no `defaultAttributes`.  Mirrors the selection logic in buildAll().
   * @param {AnnotationTagDef[]} defs
   * @param {Element} element
   * @returns {AnnotationTagDef|null}
   */
  #selectDef(defs, element) {
    let fallback = /** @type {AnnotationTagDef|null} */ (null);
    for (const d of defs) {
      if (!d.defaultAttributes) {
        if (!fallback) fallback = d;
      } else if (Object.entries(d.defaultAttributes).every(([k, v]) => element.getAttribute(k) === v)) {
        return d;
      }
    }
    return fallback;
  }

  /**
   * @param {{ clientX: number, clientY: number }} coords
   * @param {AnnotationTagDef} def
   * @param {Element} element
   */
  #show(coords, def, element) {
    if (!this.#overlay) return;
    this.#overlay.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; margin-bottom:10px; font-size:11px; letter-spacing:.05em;';
    title.textContent = `✏ ${resolveLabel(def, element)}`;
    this.#overlay.appendChild(title);

    if ((def.attributes?.length ?? 0) > 0) {
      const attrLabel = document.createElement('div');
      attrLabel.style.cssText = 'font-size:10px; color:#6c7086; margin-bottom:6px; text-transform:uppercase;';
      attrLabel.textContent = 'Attributes';
      this.#overlay.appendChild(attrLabel);
    }

    for (const attr of def.attributes ?? []) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:4px;';

      const nameEl = document.createElement('span');
      nameEl.style.color = '#89b4fa';
      nameEl.textContent = attr.name;
      row.appendChild(nameEl);

      const currentVal = element.getAttribute(attr.name) ?? '';

      if (attr.values && attr.values.length > 0) {
        const sel = document.createElement('sl-select');
        sel.setAttribute('size', 'small');
        sel.setAttribute('value', currentVal);
        sel.style.minWidth = '80px';
        for (const v of attr.values) {
          const opt = document.createElement('sl-option');
          opt.setAttribute('value', v);
          opt.textContent = v;
          sel.appendChild(opt);
        }
        sel.addEventListener('sl-change', async () => {
          element.setAttribute(attr.name, /** @type {any} */ (sel).value);
          await this.#editor.updateEditorFromNode(/** @type {Node} */ (element.parentNode));
        });
        row.appendChild(sel);
      } else {
        const input = document.createElement('sl-input');
        input.setAttribute('size', 'small');
        input.setAttribute('value', currentVal);
        input.style.minWidth = '80px';
        input.addEventListener('sl-change', async () => {
          element.setAttribute(attr.name, /** @type {any} */ (input).value);
          await this.#editor.updateEditorFromNode(/** @type {Node} */ (element.parentNode));
        });
        row.appendChild(input);
      }

      this.#overlay.appendChild(row);
    }

    const mergePrevLink = document.createElement('div');
    mergePrevLink.style.cssText = 'margin-top:8px; color:#89dceb; cursor:pointer; font-size:11px;';
    mergePrevLink.textContent = '« Merge with previous';
    mergePrevLink.addEventListener('click', async () => {
      if (!element.parentNode) return;
      const parent = mergeWithPrev(element);
      await this.#editor.updateEditorFromNode(parent);
      this.#hide();
    });
    this.#overlay.appendChild(mergePrevLink);

    const mergeNextLink = document.createElement('div');
    mergeNextLink.style.cssText = 'margin-top:4px; color:#89dceb; cursor:pointer; font-size:11px;';
    mergeNextLink.textContent = '» Merge with next';
    mergeNextLink.addEventListener('click', async () => {
      if (!element.parentNode) return;
      const parent = mergeWithNext(element);
      await this.#editor.updateEditorFromNode(parent);
      this.#hide();
    });
    this.#overlay.appendChild(mergeNextLink);

    const removeLink = document.createElement('div');
    removeLink.style.cssText = 'margin-top:8px; color:#f38ba8; cursor:pointer; font-size:11px;';
    removeLink.textContent = '✕ Remove annotation';
    removeLink.addEventListener('click', async () => {
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) parent.insertBefore(element.firstChild, element);
      parent.removeChild(element);
      await this.#editor.updateEditorFromNode(parent);
      this.#hide();
    });
    this.#overlay.appendChild(removeLink);

    const changeDivider = document.createElement('sl-divider');
    changeDivider.style.cssText = 'margin: 8px 0;';
    this.#overlay.appendChild(changeDivider);

    const changeLabel = document.createElement('div');
    changeLabel.style.cssText = 'font-size:10px; color:#6c7086; margin-bottom:6px; text-transform:uppercase;';
    changeLabel.textContent = 'Change to';
    this.#overlay.appendChild(changeLabel);

    this.#renderPalette(this.#overlay, def.tag, async (newDef) => {
      this.#hide();
      await this.#retag(element, newDef);
    });

    // Position near the badge — extra bottom margin for the "Change to" palette section
    const x = coords.clientX;
    const y = coords.clientY;
    this.#overlay.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    this.#overlay.style.top  = `${Math.min(y + 12, window.innerHeight - 280)}px`;
    this.#overlay.style.display = '';
  }

  /**
   * Renders one chip per tag definition into `container`.
   * The chip whose `tag === currentTag` is muted and non-interactive.
   * @param {HTMLElement} container
   * @param {string|null} currentTag
   * @param {(def: AnnotationTagDef) => void} onChipClick
   */
  #renderPalette(container, currentTag, onChipClick) {
    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' });
    for (const def of sorted) {
      const chip = document.createElement('span');
      chip.textContent = def.label.replace(/\{@[^}]+\}/g, '…');
      chip.title = def.description || def.label;
      const isCurrent = def.tag === currentTag;
      Object.assign(chip.style, {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: '3px',
        padding: '2px 6px 3px',
        cursor: isCurrent ? 'default' : 'pointer',
        opacity: isCurrent ? '0.4' : '1',
        userSelect: 'none',
      });
      if (!isCurrent) chip.addEventListener('click', () => onChipClick(def));
      row.appendChild(chip);
    }
    container.appendChild(row);
  }

  /**
   * Replaces `element` with a new element of `newDef.tag`, copying all existing
   * attributes then applying `newDef.defaultAttributes` on top.
   * @param {Element} element
   * @param {AnnotationTagDef} newDef
   */
  async #retag(element, newDef) {
    if (element.localName === newDef.tag) return;
    const parent = element.parentNode;
    if (!parent) return;
    const newEl = document.createElementNS(element.namespaceURI, newDef.tag);
    for (const attr of element.attributes) {
      newEl.setAttribute(attr.name, attr.value);
    }
    if (newDef.defaultAttributes) {
      for (const [k, v] of Object.entries(newDef.defaultAttributes)) {
        newEl.setAttribute(k, v);
      }
    }
    while (element.firstChild) newEl.appendChild(element.firstChild);
    parent.replaceChild(newEl, element);
    await this.#editor.updateEditorFromNode(parent);
  }

  #hide() {
    if (this.#overlay) this.#overlay.style.display = 'none';
  }
}

/**
 * Properties popup for XML annotation badges.
 *
 * Triggered by the `ann-badge-click` custom event bubbled from badge widgets.
 * Shows the annotation tag's editable attributes and a "Remove annotation" link.
 *
 * @import { XMLEditor } from '../xmleditor.js'
 */

/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null, color: string,
 *   attributes: Array<{ name: string, values?: string[]|null }> }} AnnotationTagDef
 */

export class XmlAnnotationPopup {
  /** @param {XMLEditor} editor */
  constructor(editor) {
    this.#editor = editor;
  }

  /** @type {XMLEditor} */
  #editor;

  /** @type {HTMLElement|null} */
  #overlay = null;

  /** @type {Map<string, AnnotationTagDef>} */
  #tagMap = new Map();

  /**
   * Mount the popup overlay into the editor container.
   * Call once from the annotation plugin's install().
   * @param {HTMLElement} parent
   * @param {AnnotationTagDef[]} tagDefs
   */
  mount(parent, tagDefs) {
    this.#tagMap = new Map(tagDefs.map(d => [d.tag, d]));

    const overlay = document.createElement('div');
    overlay.className = 'ann-popup';
    overlay.style.cssText = 'display:none; position:fixed; z-index:10000; background:#313244; border:1px solid #45475a; border-radius:6px; padding:12px 16px; font-size:12px; font-family:monospace; color:#cdd6f4; box-shadow:0 4px 16px rgba(0,0,0,.4); min-width:180px;';
    parent.appendChild(overlay);
    this.#overlay = overlay;

    parent.addEventListener('ann-badge-click', (e) => {
      const { tag, from, clientX = 0, clientY = 0 } = /** @type {CustomEvent} */ (e).detail;
      const def = this.#tagMap.get(tag);
      if (!def) return;
      let element;
      try { element = /** @type {Element} */ (this.#editor.getDomNodeAt(from)); } catch { return; }
      if (!element) return;
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
    this.#tagMap = new Map(tagDefs.map(d => [d.tag, d]));
    this.#hide();
  }

  // ── Private ────────────────────────────────────────────────────────

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
    title.textContent = `✏ ${def.label.replace(/\{@[^}]+\}/g, '…')}`;
    this.#overlay.appendChild(title);

    if (def.attributes.length > 0) {
      const attrLabel = document.createElement('div');
      attrLabel.style.cssText = 'font-size:10px; color:#6c7086; margin-bottom:6px; text-transform:uppercase;';
      attrLabel.textContent = 'Attributes';
      this.#overlay.appendChild(attrLabel);
    }

    for (const attr of def.attributes) {
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

    // Position near the badge
    const x = coords.clientX;
    const y = coords.clientY;
    this.#overlay.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    this.#overlay.style.top  = `${Math.min(y + 12, window.innerHeight - 200)}px`;
    this.#overlay.style.display = '';
  }

  #hide() {
    if (this.#overlay) this.#overlay.style.display = 'none';
  }
}

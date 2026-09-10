/**
 * Properties popup for XML annotation badges.
 *
 * Triggered by the `ann-badge-click` custom event bubbled from badge widgets.
 * Shows the annotation tag's editable attributes and a "Remove annotation" link.
 *
 * @import { XMLEditor } from '../xmleditor.js'
 */

/**
 * @typedef {{ attrs: Record<string,string>, description?: string|null }} AnnotationTagVariant
 * @typedef {{ tag: string, label: string, color: string,
 *   attributes?: Array<{ name: string, values?: string[]|null, required?: boolean }>|null,
 *   variants?: AnnotationTagVariant[]|null, bareAllowed?: boolean,
 *   description?: string|null, childTags?: string[]|null }} AnnotationTagDef
 */

/**
 * Resolves the popup title for `element` under `tagDef`: the bare tag name,
 * or `tag[name1=value1,name2=value2]` for the live values of whichever
 * attributes this tag's variants control — the same `name=value` form the
 * "Change to" dropdown's variant items use (see `#renderPalette`), so the
 * title reads identically to the currently-active dropdown entry, and stays
 * unambiguous for tags whose variants assign more than one attribute (e.g.
 * `title[level=a,type=decision]`). Deliberately separate from
 * `resolveLabel` (xml-annotation-decorations.js), which the compact inline
 * editor badge uses and keeps to bare values only, for space.
 * @param {AnnotationTagDef} tagDef
 * @param {Element} element
 * @returns {string}
 */
function resolvePopupTitle(tagDef, element) {
  const variantAttrNames = [...new Set((tagDef.variants ?? []).flatMap(v => Object.keys(v.attrs)))];
  const parts = variantAttrNames
    .map(name => /** @type {[string, string|null]} */ ([name, element.getAttribute(name)]))
    .filter(([, value]) => value);
  if (!parts.length) return tagDef.tag;
  return `${tagDef.tag}[${parts.map(([name, value]) => `${name}=${value}`).join(',')}]`;
}

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

/**
 * Computes the `{left, top}` viewport position (px, for `position:fixed`) of
 * a `width`x`height` overlay anchored near `(x, y)`. Default placement is
 * below-and-right of the anchor point (`y + offset`, `x`); flips to
 * above/left instead when that default would overflow the viewport's
 * bottom/right edge. Finally clamps to the viewport on all sides — this
 * both keeps a flipped placement from overflowing the opposite edge and
 * handles the degenerate case where the overlay is larger than the
 * viewport itself. Pure/DOM-free so it can be unit-tested without a real
 * layout engine (jsdom's `offsetWidth`/`offsetHeight` are always 0).
 * @param {{ x: number, y: number, width: number, height: number,
 *   viewportWidth: number, viewportHeight: number, offset?: number, margin?: number }} opts
 * @returns {{ left: number, top: number }}
 */
export function computeOverlayPosition({ x, y, width, height, viewportWidth, viewportHeight, offset = 12, margin = 8 }) {
  let left = x;
  let top = y + offset;
  if (left + width > viewportWidth - margin) left = x - width;
  if (top + height > viewportHeight - margin) top = y - height - offset;

  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const maxTop = Math.max(margin, viewportHeight - height - margin);
  left = Math.min(Math.max(left, margin), maxLeft);
  top = Math.min(Math.max(top, margin), maxTop);
  return { left, top };
}

// Shoelace's built-in "small" sl-button size is still fairly chunky
// (generous padding/height meant for a normal toolbar) — too big for a
// compact popup row of three actions that must stay on one line. `::part()`
// can't be set via an element's inline `style`, so this scoped stylesheet is
// injected into <head> once, on first mount(), rather than per popup instance.
let actionButtonStyleInjected = false;
function ensureActionButtonStyle() {
  if (actionButtonStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    .ann-popup-action-btn { flex: 1 1 0; min-width: 0; }
    /* Soft filled pill instead of a hard-edged, high-contrast bordered box —
       rounded corners + a low-opacity tint of the action's own accent color
       (cyan for merge, red for remove) read as calmer/"organic" against the
       dark popup than a stark white or fully-saturated outline. */
    .ann-popup-action-btn::part(base) {
      font-size: 11px; padding: 0 10px; height: 24px; line-height: 24px;
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: 999px;
    }
    .ann-popup-action-btn::part(label) { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ann-popup-action-btn--merge::part(base) { background-color: rgba(137,220,235,.16); color: #89dceb; }
    .ann-popup-action-btn--merge::part(base):hover { background-color: rgba(137,220,235,.28); }
    .ann-popup-action-btn--remove::part(base) { background-color: rgba(243,139,168,.16); color: #f38ba8; }
    .ann-popup-action-btn--remove::part(base):hover { background-color: rgba(243,139,168,.28); }
  `;
  document.head.appendChild(style);
  actionButtonStyleInjected = true;
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

  /** @type {Map<string, AnnotationTagDef>} */
  #tagMap = new Map();

  /** @type {((def: AnnotationTagDef, attrs: Record<string,string>) => void)|null} */
  #wrapCallback = null;

  /** @type {{ onScroll: () => void }|null} Active #trackScroll() listener, if any. */
  #scrollTracker = null;

  /**
   * Mount the popup overlay into the editor container.
   * Call once from the annotation plugin's install().
   * @param {HTMLElement} parent
   * @param {AnnotationTagDef[]} tagDefs
   */
  mount(parent, tagDefs) {
    this.#buildTagMap(tagDefs);
    ensureActionButtonStyle();

    const overlay = document.createElement('div');
    overlay.className = 'ann-popup';
    // max-width/max-height cap the popup at 30% of viewport width / 45% of viewport height
    // (the "Change to" chip palette in particular can otherwise grow as wide as
    // its longest unwrapped row, or as tall as its full attribute+chip content);
    // overflow-y:auto keeps the rest scrollable rather than spilling off-screen.
    // box-sizing:border-box makes the cap include padding, matching what
    // computeOverlayPosition/#positionOverlay then measure via offsetWidth/Height.
    overlay.style.cssText = 'display:none; position:fixed; z-index:10000; background:#313244; border:1px solid #45475a; border-radius:6px; padding:12px 16px; font-size:12px; font-family:monospace; color:#cdd6f4; box-shadow:0 4px 16px rgba(0,0,0,.4); min-width:180px; max-width:30vw; max-height:45vh; overflow-y:auto; overflow-x:hidden; box-sizing:border-box;';
    parent.appendChild(overlay);
    this.#overlay = overlay;

    parent.addEventListener('ann-badge-click', (e) => {
      const { tag, from, clientX = 0, clientY = 0 } = /** @type {CustomEvent} */ (e).detail;
      const def = this.#tagMap.get(tag);
      if (!def) return;
      const element = this.#resolveElement(from);
      if (!element) return;
      this.#show({ clientX, clientY }, def, element, from);
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
   * Register the callback invoked when the user picks a chip (or one of its
   * dropdown variants) in the selection popup.
   * Must be called once from the annotation plugin after `mount()`.
   * @param {(def: AnnotationTagDef, attrs: Record<string,string>) => void} fn
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

    this.#renderPalette(this.#overlay, null, null, (def, attrs) => {
      this.#hide();
      this.#wrapCallback?.(def, attrs);
    });

    this.#positionOverlay(coords);
  }

  // ── Private ────────────────────────────────────────────────────────

  /** @param {AnnotationTagDef[]} tagDefs */
  #buildTagMap(tagDefs) {
    this.#tagDefs = tagDefs;
    this.#tagMap = new Map();
    for (const d of tagDefs) {
      this.#tagMap.set(d.tag, d);
    }
  }

  /**
   * Resolves the CURRENT, live DOM node at a document position via a fresh
   * getDomNodeAt() call, rather than reusing an Element captured earlier.
   * `XmlEditorDomSync` rebuilds its DOM<->syntax-tree position maps from a
   * freshly re-parsed DOM (xmleditor.js's `#delayedUpdateActions`, 1 second
   * after the last document-changing transaction), which orphans any
   * Element reference captured before that rebuild — including one from
   * earlier in the SAME popup session, since a popup routinely stays open
   * longer than that debounce window while the user reads it. Every
   * deferred action below (attribute edit, merge, remove, retag) must
   * re-resolve at the moment it actually runs, not reuse the element the
   * popup opened with. Hides the popup and returns null if the position no
   * longer resolves to a live element.
   * @param {number} from
   * @returns {Element|null}
   */
  #resolveElement(from) {
    try {
      return /** @type {Element} */ (this.#editor.getDomNodeAt(from));
    } catch {
      this.#hide();
      return null;
    }
  }

  /**
   * Positions and reveals the overlay near `coords`, flipping to the
   * opposite side of the anchor point when the default placement would
   * overflow the viewport (see `computeOverlayPosition`). Must be called
   * after the overlay's content for this popup has been built, since sizing
   * depends on it. Measures with `visibility:hidden` rather than
   * `display:none` — the latter can't be measured (zero-size layout box) —
   * so there's no visible flash at the wrong position.
   * @param {{ clientX: number, clientY: number }} coords
   */
  #positionOverlay(coords) {
    const overlay = this.#overlay;
    if (!overlay) return;
    overlay.style.visibility = 'hidden';
    overlay.style.display = '';
    const { left, top } = computeOverlayPosition({
      x: coords.clientX,
      y: coords.clientY,
      width: overlay.offsetWidth,
      height: overlay.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.visibility = '';
  }

  /**
   * Keeps the popup anchored to document position `from` while the user
   * scrolls the editor. Cheap: CodeMirror's own `view.coordsAtPos()` already
   * returns viewport-relative coordinates that account for the current
   * scroll offset, so no manual scroll-delta bookkeeping is needed. Hides
   * the popup once the position scrolls out of CodeMirror's rendered
   * viewport (`coordsAtPos` then returns null).
   *
   * `coords` is the ORIGINAL open-time anchor (the click point `#show` was
   * called with), which generally isn't exactly `coordsAtPos(from)` — e.g. a
   * click lands wherever within the badge glyph, while `coordsAtPos` always
   * returns the char box's edges. The offset between the two is captured
   * once here and re-applied on every scroll tick, so the popup tracks the
   * SAME visual point it opened at instead of snapping to the char box's
   * edge on the first scroll event (which reads as an x/y jump).
   *
   * Listens on `window` with `capture:true` rather than on
   * `view.scrollDOM` directly: `scroll` events don't bubble, and in this
   * app it's `#codemirror-container` (app.css) — an ancestor of
   * `view.scrollDOM`, not `view.scrollDOM` itself — that actually has
   * `overflow:auto` and scrolls (CodeMirror's own `.cm-scroller` is left
   * unconstrained in height). A capturing listener on `window` is notified
   * of a `scroll` event on any descendant on its way down, regardless of
   * which ancestor actually owns the scrollbar, so this doesn't depend on
   * that CSS detail. A no-op if the editor doesn't expose `getView()`, or
   * `from` isn't currently rendered (e.g. a test double, or a popup opened
   * from something other than a rendered badge).
   * @param {number} from
   * @param {{ clientX: number, clientY: number }} coords
   */
  #trackScroll(from, coords) {
    this.#stopTrackingScroll();
    const view = this.#editor.getView?.();
    const anchor = view?.coordsAtPos(from);
    if (!anchor) return;
    const offsetX = coords.clientX - anchor.left;
    const offsetY = coords.clientY - anchor.bottom;
    const onScroll = () => {
      const c = view.coordsAtPos(from);
      if (!c) { this.#hide(); return; }
      this.#positionOverlay({ clientX: c.left + offsetX, clientY: c.bottom + offsetY });
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    this.#scrollTracker = { onScroll };
  }

  #stopTrackingScroll() {
    if (!this.#scrollTracker) return;
    window.removeEventListener('scroll', this.#scrollTracker.onScroll, { capture: true });
    this.#scrollTracker = null;
  }

  /**
   * @param {{ clientX: number, clientY: number }} coords
   * @param {AnnotationTagDef} def
   * @param {Element} element Freshly resolved element, safe to read synchronously below.
   * @param {number} from Document position of `element`'s open tag, for re-resolving in deferred handlers.
   */
  #show(coords, def, element, from) {
    if (!this.#overlay) return;
    this.#overlay.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; margin-bottom:10px; font-size:11px; letter-spacing:.05em;';
    title.textContent = `✏ ${resolvePopupTitle(def, element)}`;
    this.#overlay.appendChild(title);

    // One horizontal row of compact Shoelace buttons, evenly spaced across the
    // full popup width (flex:1 on each, see the injected stylesheet in
    // ensureActionButtonStyle()). Placed right under the title so these
    // frequently-used actions are visible without scrolling past the
    // attribute editors or the "Change to" palette.
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex; gap:6px; width:100%; margin-bottom:8px;';
    this.#overlay.appendChild(actionsRow);

    const mergePrevBtn = document.createElement('sl-button');
    mergePrevBtn.className = 'ann-popup-action-btn ann-popup-action-btn--merge';
    mergePrevBtn.setAttribute('size', 'small');
    mergePrevBtn.setAttribute('variant', 'text');
    mergePrevBtn.textContent = '« Merge prev';
    mergePrevBtn.addEventListener('click', async () => {
      const live = this.#resolveElement(from);
      if (!live || !live.parentNode) return;
      const parent = mergeWithPrev(live);
      await this.#editor.updateEditorFromNode(parent);
      this.#hide();
    });
    actionsRow.appendChild(mergePrevBtn);

    const mergeNextBtn = document.createElement('sl-button');
    mergeNextBtn.className = 'ann-popup-action-btn ann-popup-action-btn--merge';
    mergeNextBtn.setAttribute('size', 'small');
    mergeNextBtn.setAttribute('variant', 'text');
    mergeNextBtn.textContent = 'Merge next »';
    mergeNextBtn.addEventListener('click', async () => {
      const live = this.#resolveElement(from);
      if (!live || !live.parentNode) return;
      const parent = mergeWithNext(live);
      await this.#editor.updateEditorFromNode(parent);
      this.#hide();
    });
    actionsRow.appendChild(mergeNextBtn);

    const removeBtn = document.createElement('sl-button');
    removeBtn.className = 'ann-popup-action-btn ann-popup-action-btn--remove';
    removeBtn.setAttribute('size', 'small');
    removeBtn.setAttribute('variant', 'text');
    removeBtn.textContent = '✕ Remove';
    removeBtn.addEventListener('click', async () => {
      const live = this.#resolveElement(from);
      if (!live) return;
      const parent = live.parentNode;
      if (!parent) return;
      while (live.firstChild) parent.insertBefore(live.firstChild, live);
      parent.removeChild(live);
      await this.#editor.updateEditorFromNode(parent);
      this.#hide();
    });
    actionsRow.appendChild(removeBtn);

    const actionsDivider = document.createElement('sl-divider');
    // Shoelace's default divider color reads as a stark, high-contrast line against
    // this dark popup; --color is sl-divider's own documented custom property for this.
    actionsDivider.style.cssText = 'margin: 8px 0; --color: rgba(255,255,255,.12);';
    this.#overlay.appendChild(actionsDivider);

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
      // Fixed width + right-align so labels of different lengths (level, type,
      // key, …) don't push their input boxes to different starting positions.
      nameEl.style.cssText = 'color:#89b4fa; min-width:44px; flex-shrink:0; text-align:right;';
      nameEl.textContent = attr.name;
      row.appendChild(nameEl);

      const currentVal = element.getAttribute(attr.name) ?? '';
      // Only an attribute the schema doesn't mark required may be cleared
      // once set; `required` defaults to true (matches the backend Pydantic
      // model's default) for tag defs that predate this field.
      const removable = attr.required === false;

      // Re-sync from the freshly re-resolved live element, not `element.parentNode`
      // and not `element` itself (see #resolveElement): an attribute edit doesn't
      // restructure the parent's children, so there's no need to target the parent,
      // and by the time the user picks a value, `element` may already be orphaned.
      /** @type {HTMLElement} */
      let control;
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
          const live = this.#resolveElement(from);
          if (!live) return;
          live.setAttribute(attr.name, /** @type {any} */ (sel).value);
          await this.#editor.updateEditorFromNode(live);
        });
        row.appendChild(sel);
        control = sel;
      } else {
        const input = document.createElement('sl-input');
        input.setAttribute('size', 'small');
        input.setAttribute('value', currentVal);
        input.style.minWidth = '80px';
        input.addEventListener('sl-change', async () => {
          const live = this.#resolveElement(from);
          if (!live) return;
          const newVal = /** @type {any} */ (input).value;
          if (newVal) live.setAttribute(attr.name, newVal);
          else live.removeAttribute(attr.name);
          await this.#editor.updateEditorFromNode(live);
        });
        row.appendChild(input);
        control = input;
      }

      if (removable) {
        const clearBtn = document.createElement('span');
        clearBtn.textContent = '✕';
        clearBtn.title = `Remove ${attr.name}`;
        clearBtn.style.cssText = 'cursor:pointer; color:#f38ba8; font-size:11px;';
        clearBtn.addEventListener('click', async () => {
          const live = this.#resolveElement(from);
          if (!live) return;
          live.removeAttribute(attr.name);
          /** @type {any} */ (control).value = '';
          await this.#editor.updateEditorFromNode(live);
        });
        row.appendChild(clearBtn);
      }

      this.#overlay.appendChild(row);
    }

    const changeDivider = document.createElement('sl-divider');
    changeDivider.style.cssText = 'margin: 8px 0; --color: rgba(255,255,255,.12);';
    this.#overlay.appendChild(changeDivider);

    const changeLabel = document.createElement('div');
    changeLabel.style.cssText = 'font-size:10px; color:#6c7086; margin-bottom:6px; text-transform:uppercase;';
    changeLabel.textContent = 'Change to';
    this.#overlay.appendChild(changeLabel);

    this.#renderPalette(this.#overlay, def, element, async (newDef, attrs) => {
      this.#hide();
      const live = this.#resolveElement(from);
      if (!live) return;
      await this.#retag(live, def, newDef, attrs);
    });

    this.#positionOverlay(coords);
    this.#trackScroll(from, coords);
  }

  /**
   * Renders one split-button chip per tag definition into `container`,
   * sorted alphabetically by tag name. `currentElement` is the DOM element
   * the "Change to" popup was opened on, or `null` for a fresh-selection
   * "Annotate as…" popup (where nothing is "current" and every action is
   * enabled). Muting is computed per-action, not per-chip: since one
   * AnnotationTagDef now covers every attribute-value combination for a
   * tag, "this def is the element's current tag" no longer means every
   * action on it is a no-op — only the SPECIFIC action that reproduces
   * what the element already has is. A tag with `variants` gets a caret
   * trigger opening a dropdown of attribute-value combinations; if
   * `bareAllowed` is false, the chip body itself is inert for direct
   * insertion and only opens the dropdown when clicked.
   * @param {HTMLElement} container
   * @param {AnnotationTagDef|null} currentDef
   * @param {Element|null} currentElement
   * @param {(def: AnnotationTagDef, attrs: Record<string,string>) => void} onPick
   */
  #renderPalette(container, currentDef, currentElement, onPick) {
    const sorted = [...this.#tagDefs].sort((a, b) => a.tag.localeCompare(b.tag));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' });
    for (const def of sorted) {
      const isCurrentTag = def === currentDef;
      const variantAttrNames = (def.variants ?? []).flatMap(v => Object.keys(v.attrs));
      const isElementBare = isCurrentTag && currentElement != null &&
        variantAttrNames.every(name => !currentElement.getAttribute(name));
      const hasVariants = (def.variants?.length ?? 0) > 0;
      const bareAllowed = def.bareAllowed !== false;

      const wrapper = document.createElement('span');
      Object.assign(wrapper.style, { display: 'inline-flex', borderRadius: '3px', overflow: 'hidden' });

      const chipStyle = {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '2px 6px 3px',
        cursor: isElementBare ? 'default' : 'pointer',
        opacity: isElementBare ? '0.4' : '1',
        userSelect: 'none',
      };

      const chip = document.createElement('span');
      chip.textContent = def.label;
      chip.title = def.description || def.label;
      Object.assign(chip.style, chipStyle);
      wrapper.appendChild(chip);

      if (!isElementBare && bareAllowed) {
        chip.addEventListener('click', () => onPick(def, {}));
      }

      if (hasVariants) {
        const dropdown = document.createElement('sl-dropdown');
        const caret = document.createElement('span');
        caret.textContent = '▾';
        caret.slot = 'trigger';
        Object.assign(caret.style, { ...chipStyle, borderLeft: '1px solid rgba(0,0,0,.25)', padding: '2px 4px 3px', cursor: 'pointer', opacity: '1' });
        dropdown.appendChild(caret);

        const menu = document.createElement('sl-menu');
        for (const variant of def.variants ?? []) {
          const isActiveVariant = isCurrentTag && currentElement != null &&
            variantAttrNames.every(name => currentElement.getAttribute(name) === (variant.attrs[name] ?? null));
          const item = document.createElement('sl-menu-item');
          // name=value form (not just the bare value): disambiguates variants that
          // assign more than one attribute, e.g. `title[level=a,type=decision]`.
          const suffix = Object.entries(variant.attrs).map(([name, value]) => `${name}=${value}`).join(',');
          item.textContent = `${def.tag}[${suffix}]`;
          item.title = variant.description || def.description || def.label;
          if (!isActiveVariant) {
            item.addEventListener('click', () => onPick(def, variant.attrs));
          } else {
            item.disabled = true;
          }
          menu.appendChild(item);
        }
        dropdown.appendChild(menu);

        if (!bareAllowed) {
          // No bare-tag action: clicking the chip body also opens the dropdown.
          chip.addEventListener('click', () => { dropdown.open = true; });
        }

        wrapper.appendChild(dropdown);
      }

      row.appendChild(wrapper);
    }
    container.appendChild(row);
  }

  /**
   * Retags `element` from `currentDef` to `newDef`, applying `attrs` (the
   * chosen variant's attribute-value pairs, or `{}` for a bare-tag pick).
   * If the tag name changes, a new element is created (copying existing
   * attributes) and swapped into the parent; if unchanged, `element` is
   * mutated in place. Either way, any attribute name controlled by
   * `currentDef`'s own variants but absent from `attrs` is removed first
   * (so switching from `bibl[type=decision]` to plain `bibl` doesn't leave
   * a stale `type` attribute behind), then `attrs` is applied on top.
   * @param {Element} element
   * @param {AnnotationTagDef} currentDef
   * @param {AnnotationTagDef} newDef
   * @param {Record<string,string>} attrs
   */
  async #retag(element, currentDef, newDef, attrs) {
    const tagChanged = element.localName !== newDef.tag;
    const currentVariantAttrNames = new Set((currentDef.variants ?? []).flatMap(v => Object.keys(v.attrs)));
    const attrsChanged = [...currentVariantAttrNames].some(name => element.getAttribute(name) !== (attrs[name] ?? null))
      || Object.entries(attrs).some(([k, v]) => element.getAttribute(k) !== v);
    if (!tagChanged && !attrsChanged) return;

    const parent = element.parentNode;
    if (!parent) return;

    let target = element;
    if (tagChanged) {
      const newEl = document.createElementNS(element.namespaceURI, newDef.tag);
      for (const attr of element.attributes) {
        newEl.setAttribute(attr.name, attr.value);
      }
      while (element.firstChild) newEl.appendChild(element.firstChild);
      parent.replaceChild(newEl, element);
      target = newEl;
    }

    for (const name of currentVariantAttrNames) {
      if (!(name in attrs)) target.removeAttribute(name);
    }
    for (const [k, v] of Object.entries(attrs)) {
      target.setAttribute(k, v);
    }

    await this.#editor.updateEditorFromNode(parent);
  }

  #hide() {
    if (this.#overlay) this.#overlay.style.display = 'none';
    this.#stopTrackingScroll();
  }
}

// @ts-check

/**
 * CodeMirror decoration layer for XML annotation mode.
 *
 * Exports:
 *   resolveLabel(tagDef, element) — resolves badge label from tagDef + element attributes
 *   createAnnotationField(tagDefs) — returns a StateField that decorates annotation elements
 *   annotationTheme — EditorView.baseTheme with ann-badge, ann-outer, ann-inner styles
 */

import { StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, WidgetType, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/**
 * Resolves the display label for a badge given a tag definition and the live XML DOM element.
 *
 * Resolution order:
 *   1. labelMap: first entry whose "attr=value" matches an element attribute wins
 *   2. label template: replace `{@attrName}` tokens; remove surrounding brackets if attr absent
 *   3. plain label: returned as-is
 *
 * @param {{ tag: string, label: string, labelMap?: Record<string,string>|null, color: string, attributes: any[] }} tagDef
 * @param {Element} element
 * @returns {string}
 */
export function resolveLabel(tagDef, element) {
  if (tagDef.labelMap) {
    for (const [key, mapped] of Object.entries(tagDef.labelMap)) {
      const eqIdx = key.indexOf('=');
      if (eqIdx === -1) continue;
      const attrName = key.slice(0, eqIdx);
      const attrVal  = key.slice(eqIdx + 1);
      if (element.getAttribute(attrName) === attrVal) return mapped;
    }
  }

  // Template interpolation: replace [{@attrName}] or {@attrName}
  // If the attribute is absent, drop the whole token including any surrounding [...]
  return tagDef.label.replace(/\[?\{@([^}]+)\}\]?/g, (match, attrName) => {
    const val = element.getAttribute(attrName);
    if (val === null) return '';
    const hasBrackets = match.startsWith('[');
    return hasBrackets ? `[${val}]` : val;
  });
}

/**
 * A badge widget rendered in place of an OpenTag for a known annotation element.
 * Dispatches `ann-badge-click` custom event with { tag, from } when clicked.
 * The popup handler resolves the XML DOM element from `from` at click-time.
 */
class BadgeWidget extends WidgetType {
  /**
   * @param {string} label
   * @param {string} color
   * @param {string} tag
   * @param {number} from Document position of the open tag start
   */
  constructor(label, color, tag, from) {
    super();
    this.label = label;
    this.color = color;
    this.tag = tag;
    this.from = from;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'ann-badge';
    span.style.setProperty('--ann-color', this.color);
    span.dataset.tag = this.tag;
    span.dataset.from = String(this.from);
    span.textContent = this.label;
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      span.dispatchEvent(new CustomEvent('ann-badge-click', {
        bubbles: true,
        detail: { tag: this.tag, from: this.from, clientX: e.clientX, clientY: e.clientY }
      }));
    });
    return span;
  }

  eq(other) {
    return other instanceof BadgeWidget &&
      other.label === this.label &&
      other.color === this.color &&
      other.tag === this.tag &&
      other.from === this.from;
  }

  ignoreEvent() { return false; }
}

/** Zero-width widget that hides a CloseTag. Shared across all instances. */
class HiddenWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.style.display = 'none';
    return span;
  }
  eq() { return true; }
  ignoreEvent() { return true; }
}

const hiddenWidget = Decoration.replace({ widget: new HiddenWidget() });

/**
 * Computes a simplified badge label from tagDef.label at decoration-build time.
 * The XML DOM is not available here, so we strip {@attr} tokens and clean up brackets.
 * Full label resolution (via resolveLabel) happens at popup click time.
 * @param {{ label: string, tag: string }} tagDef
 * @returns {string}
 */
function simplifiedLabel(tagDef) {
  return tagDef.label
    .replace(/\[?\{@[^}]+\}\]?/g, '')
    .replace(/\[+\]+/g, '')
    .trim() || tagDef.tag.toUpperCase();
}

/**
 * Walks the Lezer syntax tree and builds a DecorationSet for all annotation elements.
 *
 * For each annotation element (tag name matches a tagDef):
 *   - OpenTag  → Decoration.replace → BadgeWidget (simplified label)
 *   - Content  → Decoration.mark class ann-outer (depth=1) or ann-inner (depth≥2)
 *   - CloseTag → Decoration.replace → zero-width hidden widget
 *
 * Structural tags (lb, p, etc.) are left as-is.
 * TODO: replace structural tags with icons in a future iteration.
 *
 * All decorations are collected and sorted by `from` position before being added to the
 * RangeSetBuilder, which requires strictly ascending order.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {Array<{tag: string, label: string, labelMap?: Record<string,string>|null, color: string, attributes: any[]}>} tagDefs
 * @returns {import('@codemirror/state').DecorationSet}
 */
function buildDecorations(state, tagDefs) {
  // TODO: optimize by using RangeSet.map(tr.changes) for position-only changes,
  // with targeted rebuild only when tag structure changes (annotation mode edits).
  const tagMap = new Map(tagDefs.map(d => [d.tag, d]));
  const tree = syntaxTree(state);

  /** @type {Array<{from:number, to:number, def: typeof tagDefs[0], depth:number}>} */
  const stack = [];

  /** @type {Array<{from:number, to:number, dec: import('@codemirror/state').Decoration}>} */
  const pending = [];

  tree.iterate({
    enter(node) {
      if (node.name === 'Element') {
        const openTag = node.node.firstChild;
        if (!openTag || openTag.name !== 'OpenTag') return;
        // TagName is the second child of OpenTag (first is the `<` token)
        const tagNameNode = openTag.firstChild?.nextSibling;
        if (!tagNameNode || tagNameNode.name !== 'TagName') return;
        const tagName = state.doc.sliceString(tagNameNode.from, tagNameNode.to);
        const def = tagMap.get(tagName);
        if (!def) return;

        // Determine content region: between OpenTag.to and CloseTag.from
        const closeTag = node.node.lastChild;
        const hasCloseTag = closeTag && (closeTag.name === 'CloseTag' || closeTag.name === 'MismatchedCloseTag');

        const depth = stack.length + 1;
        stack.push({ from: node.from, to: node.to, def, depth });

        // Badge for the OpenTag
        const label = simplifiedLabel(def);
        pending.push({
          from: openTag.from,
          to: openTag.to,
          dec: Decoration.replace({ widget: new BadgeWidget(label, def.color, tagName, openTag.from) })
        });

        // Content mark (between OpenTag.to and CloseTag.from)
        if (hasCloseTag) {
          const contentFrom = openTag.to;
          const contentTo   = closeTag.from;
          if (contentFrom < contentTo) {
            const cls = depth === 1 ? 'ann-outer' : 'ann-inner';
            pending.push({
              from: contentFrom,
              to: contentTo,
              dec: Decoration.mark({
                class: cls,
                attributes: { style: `--ann-color: ${def.color}` }
              })
            });
          }
          // Hidden widget for the CloseTag
          pending.push({
            from: closeTag.from,
            to: closeTag.to,
            dec: hiddenWidget
          });
        }
      }
    },
    leave(node) {
      if (node.name === 'Element') {
        const top = stack[stack.length - 1];
        if (top && top.from === node.from) stack.pop();
      }
    }
  });

  // Sort by from position (RangeSetBuilder requires strictly ascending order)
  pending.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder();
  for (const { from, to, dec } of pending) {
    builder.add(from, to, dec);
  }
  return builder.finish();
}

/**
 * Factory: creates a CodeMirror StateField parameterised by annotation tag definitions.
 * Pass the result to `createExtensionSlot().reconfigure(...)` to activate annotation mode.
 *
 * @param {Array<{tag: string, label: string, labelMap?: Record<string,string>|null, color: string, attributes: any[]}>} tagDefs
 * @returns {import('@codemirror/state').StateField<import('@codemirror/state').DecorationSet>}
 */
export function createAnnotationField(tagDefs) {
  return StateField.define({
    create: (state) => buildDecorations(state, tagDefs),
    update: (decs, tr) => tr.docChanged ? buildDecorations(tr.state, tagDefs) : decs,
    provide: f => EditorView.decorations.from(f)
  });
}

/** CSS theme for annotation decorations — applied via EditorView.baseTheme. */
export const annotationTheme = EditorView.baseTheme({
  '.ann-badge': {
    display: 'inline-block',
    background: 'var(--ann-color)',
    color: '#1e1e2e',
    fontFamily: 'monospace',
    fontSize: '9px',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderRadius: '3px',
    padding: '1px 5px 2px',
    marginRight: '3px',
    verticalAlign: 'middle',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.ann-outer': {
    background: 'color-mix(in srgb, var(--ann-color) 18%, transparent)',
    borderRadius: '3px',
  },
  '.ann-inner': {
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    textDecorationThickness: '2px',
    textDecorationColor: 'var(--ann-color)',
  },
});

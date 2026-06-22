/**
 * @import {Extension} from '@codemirror/state'
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * @typedef {object} EditorTheme
 * @property {string} id - Unique identifier used for persistence
 * @property {string} label - Display label shown in the theme menu
 * @property {string} readOnlyBackground - Background color applied when editor is read-only
 * @property {Extension[]} extensions - CodeMirror extensions to load into the theme Compartment
 */

const defaultHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#0000c0", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#0000c0" },
  { tag: tags.attributeName, color: "#7d0000" },
  { tag: tags.attributeValue, color: "#036103" },
  { tag: tags.comment, color: "#808080", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#9b2d9b" },
  { tag: tags.operator, color: "#555" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#89b4fa", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#89b4fa" },
  { tag: tags.attributeName, color: "#f38ba8" },
  { tag: tags.attributeValue, color: "#a6e3a1" },
  { tag: tags.comment, color: "#6c7086", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#cba6f7" },
  { tag: tags.operator, color: "#a6adc8" },
]);

const colorBlindHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#648fff", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#648fff" },
  { tag: tags.attributeName, color: "#dc267f" },
  { tag: tags.attributeValue, color: "#009e73" },
  { tag: tags.comment, color: "#767676", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#785ef0" },
  { tag: tags.operator, color: "#555" },
]);

const highContrastHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#0000ff", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#0000ff" },
  { tag: tags.attributeName, color: "#cc0000" },
  { tag: tags.attributeValue, color: "#006600" },
  { tag: tags.comment, color: "#595959", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#7b00a3" },
  { tag: tags.operator, color: "#333" },
]);

const darkViewTheme = EditorView.theme({
  "&": { backgroundColor: "#1e1e2e", color: "#cdd6f4" },
  ".cm-content": { caretColor: "#cdd6f4" },
  ".cm-cursor": { borderLeftColor: "#cdd6f4" },
  ".cm-gutters": { backgroundColor: "#181825", color: "#6c7086", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "#1e1e2e" },
  ".cm-activeLine": { backgroundColor: "#2a2a3d" },
  ".cm-selectionBackground": { backgroundColor: "#45475a" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "#45475a" },
  ".cm-foldPlaceholder": { backgroundColor: "#313244", color: "#cdd6f4", border: "none" },
}, { dark: true });

const lightViewTheme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#1e1e1e" },
  ".cm-gutters": { backgroundColor: "#f5f5f5", color: "#999", border: "none" },
});

/** @type {EditorTheme[]} */
export const THEMES = [
  {
    id: "default",
    label: "Default (light)",
    readOnlyBackground: "#f8efd5",
    extensions: [lightViewTheme, syntaxHighlighting(defaultHighlight)],
  },
  {
    id: "dark",
    label: "Dark",
    readOnlyBackground: "#2e2a00",
    extensions: [darkViewTheme, syntaxHighlighting(darkHighlight)],
  },
  {
    id: "colorBlind",
    label: "Color-blind friendly",
    readOnlyBackground: "#f8efd5",
    extensions: [lightViewTheme, syntaxHighlighting(colorBlindHighlight)],
  },
  {
    id: "highContrast",
    label: "High contrast",
    readOnlyBackground: "#f8efd5",
    extensions: [lightViewTheme, syntaxHighlighting(highContrastHighlight)],
  },
];

/**
 * Look up a theme bundle by id, falling back to default.
 * @param {string} id
 * @returns {EditorTheme}
 */
export function getTheme(id) {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}

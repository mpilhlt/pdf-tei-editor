# XML editor toolbar sections

Requested by Christian, 2026-11-05.

## Goal

Reorder the buttons on the right of the XML editor toolbar into three sections, and move the editor theme picker to the statusbar:

```text
[document history] [review] | [import] [export] | [wizard] [xsl transformation]
```

The theme picker moves to the far right of the statusbar, with the lowest priority, so it is the first item hidden when the editor is narrow.

## Implementation

- `app/src/templates/xmleditor-import-export-buttons.html` - after the spacer: `reviewSectionSeparator`, upload, download, `pluginSectionSeparator`.
- `XmlEditorPlugin.addToolbarWidget(widget, priority, section = 'plugins')` (`app/src/plugins/xmleditor.js`) - `'review'` inserts before the review separator, `'plugins'` after the plugin separator. Within a section, widgets are ordered by priority (highest leftmost), so the order no longer depends on the plugin install order (before, the buttons appeared in install order: review, XSL, history, wizard).
- A `MutationObserver` on the toolbar (`style`, `hidden`, `data-overflow-hidden` of its children, child list) shows a section separator only while there is a visible widget on both of its sides. This covers the revision history button, which is hidden (`display: none`) for documents without `<revisionDesc>`, and plugins that are not installed.
- Callers: `tei-tools` revision history at 94 and `unit-review` toggle at 93 in `'review'`; TEI Wizard (51.5) and XSL viewer (50.5) in `'plugins'`.
- Theme picker: `xmleditor-theme-button.html` is now an `sl-dropdown` (`hoist`, `placement="top-end"`) with a `status-button` trigger, added to the statusbar's right zone with priority -3 (indentation is -2, cursor position -1) and `style.order = 1`, so it stays rightmost also when other plugins add statusbar widgets later (the statusbar slots keep DOM insertion order). The `dropdown-open` z-index workaround of the toolbar is not needed with `hoist`.

## Documentation

- `docs/user-manual/editing-workflow.md` - toolbar table rewritten in toolbar order; core buttons only (added the strict diff toggle, the header editor, the XSL viewer note), plugin buttons (TEI Wizard) in a separate table; removed *Save revision* and *Delete*, which live in the main toolbar; statusbar description mentions the theme picker.
- `docs/user-manual/interface-overview.md` - XML editor components and the main toolbar updated to what the application ships; the previously listed *Copy*, *Move*, *Sync*, *Edit Instructions* buttons no longer exist in the core toolbar (Sync comes from the WebDAV sync plugin).
- `docs/code-assistant/plugin-development.md` - new section *Adding Buttons to the XML Editor*.

# Document rules: "Overrides active" label and override notes (#686, #687)

## #686 "Overrides active" label

- The headerbar widget was already only added for reviewers and admins, since `_refreshOverrideIndicators()` runs only after the role check in `#doRefreshResources()`. But when the user changed to one without the role, or the document was closed, the early return left a shown widget and the ref decorations in place. Both early returns now call `_clearOverrideIndicators()`, which removes the widget and rebuilds the decorations without overrides.
- Clicking the widget no longer unfolds the TEI header and selects `editorialDecl`. It opens the Tools menu with the "Edit document rules" submenu expanded, through the new `ToolsPlugin.openMenuItem(item)`: it shows the dropdown, focuses the item and sends it an `ArrowRight` keydown, which Shoelace's submenu controller handles by opening the submenu and focusing its first entry. The widget has the tooltip "Edit document rules".

## #687 Override note as motivation

The note of an override usually says why it was made.

- `guide_update.resolve_layer()` returns a layer's text, source and the selected override's stripped note (`Layer`); `layer_text()` wraps it. `DocumentRulesStore.get_selected_override()` returns the selected row.
- Update from guide: `GuideChange.human_note` is the note of the selected human override. `build_update_prompts()` appends `MOTIVATION_PROMPT_TEMPLATE` with the note in a `<change_motivation>` block, telling the model to use it to understand the change and not to copy it into the rules. The machine layer's note is not sent: it describes the machine text (e.g. `Updated from guide with <model>`), not the guide change.
- Upstream proposal: `UpstreamProposal.notes` holds `(layer name, note)` for each included layer whose selected override has a note (guide section first). The patch preamble lists them under `# Note on the guide section:` / `# Note on the machine rules:`, each note line prefixed with `# ` and stripped of control characters. `default_pull_request_text()` puts them after the description's first line; the description is also the body of the pull request's commit message.

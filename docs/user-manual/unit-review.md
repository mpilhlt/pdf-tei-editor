# Unit Review

Unit review lets reviewers go through a document unit by unit (for example each `<bibl>` of a reference list) and mark each one as **OK** or **not OK**. Several reviewers can review the same document; the editor combines their marks and shows the result as a coloured strip left of the line numbers.

## Turning review mode on

Click the **Review** button (clipboard icon) in the XML editor toolbar. Review mode adds:

- the status strip left of the line numbers,
- a progress meter in the status bar (`12 OK · 2 not OK · 30 open`); clicking it shows the diagnostics drawer,
- a **Review** row of buttons at the top of the editor's context menu, and keyboard shortcuts.

Hover over the **Review** button to see the list of shortcuts.

The setting is remembered in the browser. A document that has units marked not OK, disputed units, or units changed after a not-OK review turns review mode on when it is loaded, so that the feedback is visible; it is turned off again when you load a document without such units, unless you switched it on yourself.

Only users with the *reviewer* or *admin* role can set marks; everyone else sees the strip and the marks read-only. For them, the review popover shows only the reviews and the combined result.

## Review units

A review unit is an element below `<text>`. Which elements are units depends on the document variant: for GROBID reference data, each `<bibl>`; for segmentation data, each section (`<front>`, `<body>`, `<listBibl>`, …). For other documents the editor steps down from `<text>` while there is only one non-empty child element (so `<front/><body/><back><listBibl>…` leads to the `<bibl>`s) and takes the children of the first element with several. The path used is recorded in the document the first time a mark is set, so the units stay the same for all reviewers.

When several units share a line, the strip shows the line in amber if their states differ. Pretty-print the document (TEI Wizard) to put each unit on its own line.

## Marking units

Reviewers mark units in every document they can see, also in documents they cannot edit (for example an annotator's version when only owners can edit): the text stays read-only, and the server saves only your own marks into the document. Superseded versions cannot be reviewed. See [Reviewing and Commenting Documents You Cannot Edit](editing-workflow.md#reviewing-and-commenting-documents-you-cannot-edit) for the workflow.

The keyboard shortcuts act on the unit at the cursor (also when other units share its line) or on all units in the selection, in the XML view as well as in the visual annotation mode. The buttons of the **Review** row in the context menu act on the unit you right-clicked, or on the selected units if you right-clicked inside the selection. Hover over a button to see what it does and its shortcut.

| Action | How |
| --- | --- |
| Mark as OK and go to the next unit | `Ctrl+Enter` (`Cmd+Enter` on macOS), or the green ✓ button |
| Mark as not OK, with a short comment | `Ctrl+Shift+Enter`, then type the comment and press `Enter` (`Esc` keeps the mark without a comment), or the red ✕ button |
| Remove your mark | `Ctrl+Shift+Backspace`, or the eraser button |
| Mark several units as OK | Select them and press `Ctrl+Enter`, or drag over the strip (hold `Alt` while dragging to mark them not OK) |
| Mark all units above as OK | The double-check button (only units you have not marked yet) |
| Open the review of a line | Click the strip: shows your mark and comment, the other reviewers' marks, and the combined result |
| Next unit you have not reviewed / next not-OK unit (also disputed units and units changed after a not-OK review) | `F7` / `Shift+F7`, or the arrow / exclamation mark button |
| Final review (only in *final* mode) | `Ctrl+Alt+Enter` (OK) / `Ctrl+Alt+Shift+Enter` (not OK), the green and red badge buttons, or the **Final review** box in the popover |

Units marked not OK by the combined result are also listed in the diagnostics drawer, with buttons to open the review and, for reviewers, to mark them OK or not OK. So are units that were edited after a not-OK review ("Changed after a not-OK review … please check again"): these are usually the corrections of the annotator, which the reviewer should confirm or mark not OK again.

A not-OK mark is sent as a [message](messages.md) to the owner of the document (if you review in your own copy of it, to the owner of the version you copied). Type `@` in the comment of the mark to mention someone else, too.

Marks are part of the document: they are saved with it, can be undone with `Ctrl+Z`, and are kept when a new version is created.

## Colours of the strip

| Colour | Meaning |
| --- | --- |
| Green | OK |
| Red | Not OK |
| Red/green | Disputed: as many OK as not-OK votes, needs another reviewer |
| Grey dashes | The unit was edited after it was reviewed and needs a new review |
| Amber | Several units with different states share the line |
| None | Not reviewed yet |

## Combining the marks of several reviewers

The administrator sets the review mode in the configuration (`unit-review.mode`):

- **majority** (default): each reviewer's mark is one vote. A tie is shown as disputed. Use an odd number of reviewers.
- **final**: a reviewer can set a *final* review that overrides all other marks of the unit. A new final review replaces an earlier one.

## LLM reviewer

When review mode is on and you run **Review Annotations** (Tools menu, LLM Reviewer plugin) in a document you can edit, the model records its result as a reviewer of its own: the units of each reviewed part are marked OK, or not OK with the model's rationale as comment. By default the model's marks count as votes; with `unit-review.llm-vote` set to `false` they are only shown for units no person has reviewed yet.

### Adjusting the rules the model uses

**Tools → Edit document rules** lists the rule categories the document links to. Each category can have two layers, shown as tabs in the editor:

- **Guide (human)**: the section of the annotation guide that people read in the Annotation Guide drawer. An override here replaces that section only, not the whole guide file.
- **Machine rules**: the condensed text the LLM reviewer receives. Only shown when the category has a machine version in a separate file.

Each tab has its own list of versions (**Original**, **Override 1**, ...) and its own selection: choosing an override on one tab does not change the other. Click **New override** to start from the text currently shown, edit it and click **Save**. Other users are not affected.

When a category has both layers, a status line below the tabs shows whether the machine rules are up to date with the guide section. It compares the texts you currently have selected on both tabs (your override, or else the original) with the sync marker in the machine rules:

| Status line | Meaning |
| --- | --- |
| In sync with the guide | Neither the guide section nor the machine rules changed since the last sync. |
| Machine rules outdated: the guide changed since the last sync | The guide section changed; the machine rules still reflect the old text. |
| Machine rules edited by hand since the last sync | The machine rules changed, the guide section did not. |
| Machine rules outdated and edited by hand | Both changed. |
| No sync marker | The machine rules carry no marker, so nothing can be compared. |

When the guide changed and the guide is on GitHub or GitLab, the line also names the commit of the guide that the machine rules were last synced with, e.g. "(last sync: a1b2c3d)". The line is refreshed when you switch tabs, select a version or save.

Which override the LLM reviewer uses: if the category has a separate machine version, your selected override on **Machine rules**; otherwise your selected override on **Guide (human)**.

If you select an override of the guide section, the Annotation Guide drawer shows your text for that section and marks it with a **Personal version** badge.

An override that was written against an older version of the original is marked with a warning when the original has changed since ("Based on an older version of the original"). Review it against the current original and save it again to clear the marker.

**Reset to original** reloads the rules of both tabs from their source, but removes only the overrides of the tab you are on. Overrides of the other tab are kept and may then be marked as based on an older version.

**Update from guide** (button on the **Machine rules** tab, for reviewers and admins) has a language model update the machine rules after the guide section changed. The dialog shows how the guide section changed since the machine rules were last synced (**Change in the guide**), lets you choose a model and click **Generate**, and shows the result as a diff against the current machine rules (**Proposed machine rules**); both diffs show only the changed lines with a few lines of context, and a click on a collapsed stretch expands it. Nothing is saved until you click **Accept as new override**, which appears once there is a proposal: the proposal then becomes a new override of the machine rules, selected for you, with a note naming the model. Other users and the original are not affected, and you can edit the override afterwards.

After you accept an update, the status line keeps showing that the machine rules are outdated until the change is synced upstream, because the sync marker in the machine rules stays unchanged until then. If the selected machine rules already came from such an update, the dialog warns you that running the update again may apply the same change twice.

The dialog works in one of two modes:

- **Delta**: the guide commit that the machine rules were last synced with was found. The model sees the old and the new guide section and changes only what the change affects.
- **Align**: no sync base was found, for example because the machine rules have no sync marker, the guide is not on GitHub or GitLab, or the synced commit is not among the guide's recent history. The dialog says so, and the model compares the whole guide section with the machine rules.

The guide text and machine rules used are the ones you currently have selected on each tab (your override, or else the original). If no language model is available to you, the dialog says so; update the machine rules by hand, using the change shown in the dialog, and save them as an override.

**Propose change upstream** opens the source file of the rules on GitHub or GitLab with your text in place of the original. For a guide section, your text replaces that section in the file; for machine rules, it replaces the excerpt. The rest of the file stays unchanged.

For a category with both layers, the same **Propose change upstream** button opens the **Propose upstream** dialog, which proposes the guide section and the machine rules together as a patch. The dialog has the checkboxes **Guide section (human)** and **Machine rules**; a layer is checked when you have selected an override of it, and if you have selected none, the layer of the tab you are on is checked. It shows one diff per changed file, headed by the file's path in the guide repository, against the current default branch of the repository. The section is found by its heading, even if it moved in the file since the version your override is based on. If the section's content changed upstream since then, the dialog warns you, because the patch replaces those changes. Both files must be in the same repository.

The patch is built from your saved texts. If the editor shows changes you have not saved, the dialog says that they are not included; save them first.

If the guide repository is on GitHub, the dialog also shows a **Pull request title** and a **Description** (both prefilled, and editable) and a **Create pull request** button. Above the title, the dialog names the repository the pull request will be opened on. The button opens a pull request with the changed files in one commit, and the dialog then shows a link to it. Guides on GitLab keep the patch download only.

Creating a pull request needs a GitHub personal access token, stored under **GitHub** in your API keys (the dialog asks for it when it is missing). Create one at <https://github.com/settings/tokens> (the **GitHub** entry's help link opens the form for a classic token with `public_repo` preselected):

- A classic token with the `public_repo` scope (`repo` for a private guide repository) works whether or not you have push access to the guide repository.
- A fine-grained token needs read and write access to "Contents" and "Pull requests" on the guide repository. If you have no push access, it may not be able to create the fork that is then needed, so a classic token is the safer choice.

If you have push access to the guide repository, the changes go on a new branch there. Otherwise a fork of the repository is created in your GitHub account (or an existing one is used), the branch is created in the fork, and the pull request is opened from it; the dialog names the fork. Pull requests from a fork allow the maintainers of the guide repository to edit the branch.

If the guide changed upstream between the moment the dialog showed the diffs and your click on **Create pull request**, no pull request is created and the dialog asks you to close and reopen it to see the current changes.

The patch updates the sync marker in the machine rules, depending on what you include:

| Included | Effect on the sync marker |
| --- | --- |
| Guide section only | The machine rules are marked as outdated until they are updated from the guide. |
| Machine rules (with or without the guide section) | The marker records your current guide text (your override, or else the original) as the one the machine rules were derived from. If the guide section upstream after the patch is the same text, the machine rules are marked as in sync with the guide. If it differs, for example because you propose only the machine rules but have changed the guide section, the dialog warns that the machine rules will be marked as outdated. |

Click **Download patch** to save `<category>-rules.patch`. To apply it, run `git apply <file>` in a clone of the guide repository, commit, and open a pull request. If the section no longer exists in the repository, or nothing would change, the dialog says so.

Overrides of the whole guide file that were created before this change are cut down to the section they belong to when the instance is upgraded. They are removed only if they cannot be matched to a section. If you had selected such an override of the guide before the previous release, it now appears as an override of the guide section.

### After a proposal is merged

Once a proposal has been merged, the editor marks each of your overrides whose text the guide upstream now contains with a cloud icon, and a status line says how many overrides are now in upstream. The **Update to upstream** button then applies the current upstream rules to the document and removes only those overrides. Overrides that differ from upstream are kept. A confirmation names the counts before anything is changed. After the document is updated, the server checks again, against the rules the document is now pinned to, that they contain each override before it deletes it: an override is only removed when the version of the rules the document now references contains its text. If a deletion fails partway, the message says how many overrides were already removed.

## Edited units

A mark belongs to the exact content of a unit. When you edit a reviewed unit in the editor, its marks are kept as "before the last edit" and the unit is shown with grey dashes until it is reviewed again; undoing the edit restores the marks. If one of these marks was not OK, the unit is also listed in the diagnostics drawer. Marks of units that were changed outside the editor (for example by uploading a new file) are removed the next time a mark is set.

## Starting a version without reviews

When saving a revision to a new personal version, reviewers and admins can check **Clear reviews** in the Save Revision dialog. The new version then starts without review marks; the original keeps its marks.

## Approving a document

When a revision is saved with the status *approved* and the document's review has units that are not OK, disputed or not reviewed, the editor asks for confirmation first.

## How the marks are stored

The `<standOff>` element holds no human-readable data (besides the review marks, it can hold [unit comments](unit-comments.md)). It is folded when a document is loaded, when it is created, and whenever the TEI header is folded; you can unfold it temporarily. Only admins can edit it by hand; the marks are changed through review mode.

The marks are stored in the document in `TEI/standOff/listAnnotation[@type="unit-review"]`, with one `<annotation motivation="assessing">` per reviewer. Units are identified by a short fingerprint of their content, so `<text>` itself is not changed. The `<note type="summary">` of the list holds the counts shown in the progress meter.

```xml
<standOff>
  <listAnnotation type="unit-review" subtype="fp-sha256-8-v1">
    <note type="unit-xpath">./listBibl/*</note>
    <note type="summary">units=3 ok=1 not-ok=1 disputed=0 open=1</note>
    <annotation xml:id="ur-jdoe" motivation="assessing" target="#xpath(//text)" resp="#jdoe">
      <revisionDesc><change when="2026-10-23T14:02:11Z"/></revisionDesc>
      <note type="ok">b7d7ec9c</note>
      <note type="not-ok" n="9e0d6dc9">wrong year</note>
    </annotation>
  </listAnnotation>
</standOff>
```

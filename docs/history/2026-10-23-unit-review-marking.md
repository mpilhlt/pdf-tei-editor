# Unit review marking (concept)

Status: concept agreed, not implemented. Mockups: `unit-review-marking/*.png` in the project files folder (rendered from `mockups.html`). Mockups 1–5 also show alternatives that were rejected. 6–8 show the agreed design. The decisions below take precedence.

## Goal

Reviewers go through a document and mark each part of it as **unreviewed**, **reviewed – OK** or **reviewed – not OK**. The state is shown in the CodeMirror gutter, saved in the TEI document, and shows how much of a document has been reviewed.

## Decisions

| Question | Decision |
| --- | --- |
| Review unit | An element (a "review unit"), not a line. In formatted documents one unit is one line in most cases. |
| Naming | `unit-review` for the TEI `@type`, the `xml:id` prefix (`ur-`), the config keys and the plugin name, since units are reviewed, not lines. |
| Identifying units | A fingerprint (content hash) of each unit, stored stand-off. No `xml:id` on the units. |
| Storage | `standOff/listAnnotation[@type="unit-review"]` with one `annotation[@motivation="assessing"]` per reviewer (option S1) |
| Gutter | Status strip left of the line numbers (variant A), plus an "uncertain" colour |
| Progress | Status bar meter (P1) and counts in document lists (P4) |
| Several reviewers | Only a combined view. Hovering a "not OK" line shows who disagrees. How marks are combined is set by the admin (`unit-review.mode`): majority or final reviewer. |
| Comments | A not-OK mark can carry a short comment. |
| New versions | Keep the marks. |
| LLM | The LLM Reviewer plugin acts as one more reviewer. Its findings become not-OK marks with comments. |

## Context in the code base

- `XMLEditor.createExtensionSlot()` (`app/src/modules/xmleditor.js`) gives a plugin its own reconfigurable compartment. A `unit-review` plugin adds a `gutter()` with `GutterMarker`s and a `StateField` there, as `xml-annotation` does.
- Lines marked not OK can be fed into the diagnostics drawer (`app/src/plugins/diagnostics-drawer.js`) as `info` diagnostics through `XMLEditor.addLinter()`.
- The XML editor status bar (`app/src/modules/panels/status-bar.js`, `status-*` widgets) takes the progress meter.
- Reviewers are identified the way annotators already are: `respStmt/persName/@xml:id` holds the user id, and pointers like `#cboulanger` refer to it.
- The document status (`annotation.lifecycle.order`) is read from the **last** `revisionDesc/change` (`@status`, `@when` and `note[@type="label"]`, see `fastapi_app/lib/utils/tei_utils.py`). Unit review must therefore **not** append `change` elements of its own: that would overwrite the status, the label and the revision date. The review summary goes into `standOff` instead (see below).
- The fossil schemas are strict. `TEI` allows only `teiHeader` and `text`, and no unit element allows `@xml:id`. The storage below needs a fossil schema change to allow `standOff`.

## TEI practice (summary of the research)

| Mechanism | Fit |
| --- | --- |
| `revisionDesc/change` with `@status`, `@who`, `@when` | Records whole-document revisions. In this app it already carries the lifecycle status, so it can't take review data. |
| `@change` (att.global.change) on elements | Idiomatic inline TEI, but adds an attribute to every unit and puts noise into training data and diffs. |
| `@cert` / `@resp` | About the certainty of the encoding, not a review verdict. |
| `certainty` / `respons` | Stand-off statements about certainty or responsibility, with no OK / not OK value. |
| `standOff/listAnnotation/annotation` with `@motivation="assessing"`, `@target`, `@resp` | Stand-off annotation following W3C Web Annotation. "Assessing" means to judge the target. An annotation may contain `respStmt`, `revisionDesc` and `note`. **Chosen.** |
| Processing instructions (oXygen style) | Not TEI, change the content being reviewed, lost in round-trips. |
| Content hashes as `xml:id` on units | Rejected. See [Why not xml:id](#why-not-xmlid). |

Prior art in tools works at page level, not element level: Wikisource uses page states (not proofread, problematic, proofread, validated), and Transkribus uses page statuses (in progress, done, final, ground truth).

## Review units

- Each model variant defines its review units as an XPath relative to `text`. For the GROBID variants this lives in the extractor's variant configuration (pte-plugins). Examples:
  - reference segmenter and references: `.//listBibl/bibl`
  - segmentation: `./*` (front, body, note, listBibl, page …)
- The default for variants without a setting: start at `text` and step down while the current element has exactly one element child and no text of its own, then take that element's children. This finds the `bibl`s under `text > listBibl` and `text > back > listBibl`.
- A unit covers the lines from its start tag to its end tag. If a unit spans several lines, all of them show the unit's state.
- Lines outside any unit (blank lines, `<listBibl>`, `</listBibl>`) are not reviewable. They get no mark and are not counted.
- **Uncertain lines**: a line is shown in the "uncertain" colour when it holds several units whose states differ, or a unit together with text that belongs to no unit. If all units on a line have the same state, the line shows that state. Marking an uncertain line marks every unit on it. Pretty-printing the document puts each unit on its own line and removes the uncertainty. The tooltip says so.

## Fingerprints

- A fingerprint is the first 8 hex characters of a SHA-256 hash over the unit's canonical form: tag names, attributes sorted by name, child structure, and text with whitespace collapsed. Pretty-printing and re-indenting do not change it. Changing text, markup or attributes inside the unit does.
- Units with identical content (e.g. two `<bibl>Ibid.</bibl>`) get `.2`, `.3` … in document order.
- Effects:
  - Editing a unit gives it a new fingerprint. Its old marks no longer match and it falls back to unreviewed, for all reviewers. This also covers edits outside the editor and merges between versions.
  - Moving, inserting or deleting other units changes nothing.
  - Unreviewed is the default and is never stored.
- Computed on the client from the parsed document the editor already keeps.

### Non-matching fingerprints

A stored mark whose fingerprint matches no unit in the document is an orphan. What happens to it depends on where the edit came from:

- **Edit in the editor (normal case):** the plugin's state field maps unit positions through every change, so it knows which unit was edited and what its marks were. On save, every reviewer's mark on it is rewritten under the new fingerprint as `was-ok` / `was-not-ok`, keeping the comment. The unit counts as unreviewed and shows the dashed strip. The tooltip and the review popover show "was not OK (Jane Doe): Label "8" belongs to the previous footnote". A reviewer can check the fix against the comment. The `was-*` notes are removed once someone reviews the unit again. If the unit is edited again before that, they move along to the newest fingerprint.
- **Undo:** within a session, undoing the edit restores the old fingerprint, and the original marks come back as they were.
- **Edit outside the editor** (import, script, another tool) or a unit deleted in the editor: the old unit can't be found, so the orphan is removed on the next save. Nothing is lost for good, because the previous version of the document still holds it.
- Orphans are never removed when a document is only opened and not saved.

## Storage

```xml
<TEI>
  <teiHeader>…</teiHeader>
  <standOff>
    <listAnnotation type="unit-review" subtype="fp-sha256-8-v1">
      <note type="unit-xpath">.//listBibl/bibl</note>
      <note type="summary">units=184 ok=112 not-ok=8 disputed=1</note>
      <annotation xml:id="ur-cboulanger" motivation="assessing" target="#xpath(//text)" resp="#cboulanger">
        <revisionDesc><change when="2026-10-23T18:02:11Z"/></revisionDesc>
        <note type="ok">3f9c2e1a 0b77d4a2 9e01c3f4 0b77d4a2.2 …</note>
        <note type="not-ok" n="c41a07de">Label "8" belongs to the previous footnote</note>
        <note type="not-ok" n="5d10e3aa"/>
        <note type="final-ok">77e2b910</note>
        <note type="was-not-ok" n="a0c4f1d2">Label "8" belongs to the previous footnote</note>
      </annotation>
      <annotation xml:id="ur-llm-kisski-llama-3.3" motivation="assessing" target="#xpath(//text)">
        <respStmt><resp>LLM Reviewer</resp><name type="software">KISSKI / Llama 3.3</name></respStmt>
        <revisionDesc><change when="2026-10-23T19:52:40Z"/></revisionDesc>
        <note type="ok">3f9c2e1a 9e01c3f4 …</note>
        <note type="not-ok" n="c41a07de">Footnote number 8 is tagged as label of this entry, but the text continues the previous one.</note>
      </annotation>
    </listAnnotation>
  </standOff>
  <text>…</text>
</TEI>
```

- There is one `annotation` per reviewer (`@resp`, `@xml:id="ur-<userid>"`), so marks are always attributable and never overwrite each other.
- The notes inside an annotation:
  - `note[@type="ok"]`: a space-separated list of fingerprints.
  - `note[@type="not-ok"]`: one per unit, with the fingerprint in `@n` and the optional comment as content.
  - `note[@type="final-ok"]` / `note[@type="final-not-ok"]`: final reviews, only in final-reviewer mode, in the same forms.
  - `note[@type="was-ok"]` / `note[@type="was-not-ok"]`: marks carried over after an edit in the editor (see [Non-matching fingerprints](#non-matching-fingerprints)).
- An LLM reviewer has no user account, so its annotation has no `@resp` but a `respStmt` naming the model. Its id is `ur-llm-<provider>-<model>`, so each model is a reviewer of its own.
- `note[@type="unit-xpath"]` records which elements were fingerprinted (the variant's review-unit XPath, relative to `text`). The document's schema doesn't change while it is edited, so this documents the units rather than guarding against a change. If the configured XPath ever differs from the recorded one, the editor keeps using the recorded one for that document and shows a warning. A reviewer can switch the document to the new definition, which resets the marks that no longer match.
- `listAnnotation/@subtype` names the fingerprint algorithm. If the canonical form ever has to change, a new version can recompute the old fingerprints on load instead of losing all marks. The reviewer's `persName` is added to `respStmt` the way it is done for annotators. The `change` inside the annotation dates that reviewer's last marking. It is nested in the annotation and does not affect the document's `revisionDesc`.
- `note[@type="summary"]` holds the combined counts, written on every save. The backend reads it with a simple key=value parse for the dashboard's review queue and the file drawer (P4), so it never has to compute fingerprints. `note` is allowed in `listAnnotation` (model.annotationLike).
- `text` stays untouched. The training export can drop `standOff` or keep it as provenance.
- Size: about 9 bytes per reviewed unit per reviewer.

### Why not xml:id

Hashes as `xml:id` on the units were considered and rejected:

1. "Top-level children of text" is the wrong level for the reference models, where `text` has a single `listBibl` child holding all `bibl`s.
2. An id that changes with the content is a checksum, not an identifier. Every edit would rewrite it, so diffs fill with id changes and pointers to the old id break.
3. Identical units produce duplicate ids, which is invalid XML. Order-based suffixes change when units are reordered.
4. Every unit gets an attribute, which needs schema changes in all fossil models and adds noise to the training data.

Stable ids assigned once (`xml:id="b12"`, with the hash kept stand-off) would be the most idiomatic TEI, but they have the same noise problem (point 4). They are only worth it if other tools need to point at single units.

## Combining reviews

The gutter shows one combined state per unit. How it is computed is set by the admin in `unit-review.mode`:

### Mode `majority`

- Every reviewer's mark is a vote. The LLM Reviewer votes too if `unit-review.llm-vote` is `true`, and is advisory only otherwise.
- More not-OK than OK votes → **not OK**. More OK than not-OK → **OK**. A tie (e.g. 1 : 1) → **disputed**, which counts as open until another reviewer votes. No votes → unreviewed.
- A single vote decides while no one disagrees. There is no minimum number of votes. Projects that want to avoid ties use an odd number of reviewers. A minimum can be added in a later iteration.

### Mode `final`

- Votes are combined exactly as in majority mode.
- In addition, any user with the `reviewer` role can set a **final review** (OK or not OK) in the review popover or with the final shortcuts. A final review overrides all votes on that unit.
- There is at most one final review per unit. Setting one removes another reviewer's final review on that unit. Their ordinary vote stays, so the history of who thought what is kept.
- An edit to the unit turns a final review into `was-*` like any other mark.

### In both modes

- Switching the mode only changes how the stored marks are combined. The stored data stays the same, except that final reviews are ignored in majority mode.
- Marking always changes only the current user's own annotation, apart from the final-review rule above.
- Hovering a line shows every reviewer's mark, comment and date, so disagreement is visible without a separate view.

## LLM Reviewer integration

The LLM Reviewer plugin (`annotation-review` in pte-plugins) already reviews the document chunk by chunk. Its chunks are cut at element boundaries, so units are not split. Each finding quotes the text it applies to (`old`) and comes with a rationale and a proposed fix. When the `unit-review` plugin is installed, the LLM Reviewer additionally records its result as marks:

- The `unit-review` plugin offers an API through `getDependency('unit-review')`:
  - `getUnits()` returns the fingerprint and range of every unit.
  - `setMarks(reviewer, marks)` takes a reviewer descriptor (id and display name) and a list of `{fingerprint, state, comment}`.
- After each chunk that completed successfully, the extension assigns each located finding to the unit that contains its range. Units with at least one finding are marked **not OK**, with the rationales joined as the comment. All other units fully inside the chunk are marked **OK**. The model has seen them and found nothing, so the prompt does not need to change.
- Chunks that failed, were cut off or were cancelled produce no marks. When the review is limited to one node (navigation mode), only the units in that node are marked.
- The findings stay in the diagnostics drawer as they are now, with "Propose fix". The `unit-review` plugin adds no second diagnostic for a unit that already has an LLM finding. After a reload, when the LLM plugin's session cache is gone, the LLM's not-OK marks from the file show up as unit-review diagnostics, with the comment but without "Propose fix".
- Applying a proposed fix changes the unit, so the LLM's not-OK mark becomes `was-not-ok`, and a human (or a new LLM run) reviews the unit again.
- Whether the LLM's marks count as votes is set by `unit-review.llm-vote`. An LLM can never set a final review.
- The LLM's marks, OK as well as not OK, count as reviewed in the progress meter.

The reverse direction works through the diagnostics drawer as well. Not-OK and disputed units appear there as `info` diagnostics, registered with `XMLEditor.addLinter()`, with these actions:
- **OK** / **Not OK**: sets your own vote.
- **Open review**: opens the review popover.
- For LLM findings: **Propose fix** and **OK anyway**.

## Workflow

1. A reviewer opens a document (normally in status `in-review`) and turns on **Review** in the XML editor toolbar. This shows the strip and enables the shortcuts and menu entries. Nothing changes for users who don't review.
2. The reviewer moves through the document. The PDF viewer follows the cursor as it does now (Autosearch).
3. Marking. Every action applies to the units under the cursor line, or to every unit the selection touches:
   - `Ctrl/⌘+Enter`: mark OK, then jump to the next unreviewed unit.
   - `Ctrl/⌘+Shift+Enter`: mark not OK. A small comment field opens at the line. `Enter` saves the comment and jumps to the next unit, and `Esc` skips the comment.
   - `Ctrl/⌘+Alt+Enter` / `Ctrl/⌘+Alt+Shift+Enter`: final OK / final not OK (final-reviewer mode, reviewer role only).
   - `Ctrl/⌘+Shift+Backspace`: remove your mark.
   - `F7` / `Shift+F7`: next unreviewed unit / next not-OK unit. `F8` stays "next diagnostic".
   - **Clicking the strip opens the review popover** for the unit. This is where a review is revised. It shows:
     - your mark, as a three-way switch (unreviewed, OK, not OK)
     - your comment
     - the "Final review" checkbox (final-reviewer mode, reviewer role only)
     - every other reviewer's mark, comment and date, including the LLM's, and any `was-*` marks
     - the combined result
   - Dragging in the strip marks a range OK, and Alt-dragging marks it not OK, without comments.
   - The gutter context menu (extending `xml-editor-context-menu.js`) offers: mark the selection, mark everything above the cursor, and pretty-print to resolve uncertain lines.
   - `Mod-Enter` (CodeMirror: `insertBlankLine`) is overridden only while review mode is on. Check the final keys against browser-reserved shortcuts before implementing.
4. Fixing: an annotator or reviewer edits a not-OK unit. It becomes unreviewed, and the old marks and comments are kept as `was-*` (see [Non-matching fingerprints](#non-matching-fingerprints)). The strip shows a dashed bar, and the popover shows the old comment next to the new state.
5. Marking makes the document dirty like any edit, and saving writes the annotations and the summary. Saving as a new version keeps all marks, since the copy carries the `standOff`.
   - **Clear reviews:** the Save Revision dialog (`app/src/templates/save-document-dialog.html`) gets a "Clear reviews" checkbox in the "Save to a new personal version" section, below the label field. It is shown only while that option is checked and only to users with the `reviewer` or `admin` role. When it is checked, the copy is saved without `standOff/listAnnotation[@type="unit-review"]`. An empty `standOff` is removed as well. The original document keeps its marks. Help text: "Starts the new version without any review marks. The original keeps them."
6. Progress shows in the status bar meter (P1), e.g. "112 OK · 8 not OK · 64 open". Clicking it jumps to the next open unit. The counts appear in the review queue and the file drawer (P4).
7. Before setting `approved`, the save dialog warns if there are not-OK or unreviewed units. This is a warning, not a block.

## Gutter colours

| State | Strip |
| --- | --- |
| Unreviewed | none |
| OK | green |
| Not OK | red |
| Edited since review (counts as unreviewed) | dashed, in the former colour |
| Disputed (tie in the votes) | split red/green |
| Uncertain (several units with different states, or loose text) | amber |

## Required changes

- fossil: allow `standOff/listAnnotation(note?, annotation*)` with `annotation(respStmt?, revisionDesc?, note*)`, the attributes used above, and `note/@n` in all training schemas.
- pte-plugins:
  - GROBID: a review-unit XPath per variant.
  - annotation-review: record chunk results through `setMarks()`.
- pdf-tei-editor:
  - Save Revision dialog: the "Clear reviews" checkbox (`document-actions.js` and its template), which removes the `unit-review` `listAnnotation` from the copy before it is saved.
  - frontend `unit-review` plugin: gutter, state field, fingerprinting, keymap, context menu entries, comment field and review popover, status bar widget, linter source for the diagnostics drawer, and the `getUnits()` / `setMarks()` API.
  - config: `unit-review.mode` (`majority` or `final`) and `unit-review.llm-vote` (boolean).
  - backend: parse `note[@type="summary"]` into file metadata for P4.

## Open questions

None at the moment. Possible later refinement: a minimum number of votes in majority mode.

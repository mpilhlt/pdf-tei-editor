# Line review marking (concept)

Status: concept agreed, not implemented. Mockups: `line-review-marking/*.png` in the project files folder (rendered from `mockups.html`). The mockups still show some alternatives that were rejected. The decisions below take precedence.

## Goal

Reviewers go through a document and mark each part of it as **unreviewed**, **reviewed – OK** or **reviewed – not OK**. The state is shown in the CodeMirror gutter, saved in the TEI document, and shows how much of a document has been reviewed.

## Decisions

| Question | Decision |
| --- | --- |
| Review unit | An element (a "review unit"), not a line. In formatted documents one unit is one line in most cases. |
| Identifying units | A fingerprint (content hash) of each unit, stored stand-off. No `xml:id` on the units. |
| Storage | `standOff/listAnnotation[@type="line-review"]` with one `annotation[@motivation="assessing"]` per reviewer (option S1) |
| Gutter | Status strip left of the line numbers (variant A), plus an "uncertain" colour |
| Progress | Status bar meter (P1) and counts in document lists (P4) |
| Several reviewers | Only a combined view. Hovering a "not OK" line shows who disagrees. |

## Context in the code base

- `XMLEditor.createExtensionSlot()` (`app/src/modules/xmleditor.js`) gives a plugin its own reconfigurable compartment. A `line-review` plugin adds a `gutter()` with `GutterMarker`s and a `StateField` there, as `xml-annotation` does.
- Lines marked not OK can be fed into the diagnostics drawer (`app/src/plugins/diagnostics-drawer.js`) as `info` diagnostics through `XMLEditor.addLinter()`.
- The XML editor status bar (`app/src/modules/panels/status-bar.js`, `status-*` widgets) takes the progress meter.
- Reviewers are identified the way annotators already are: `respStmt/persName/@xml:id` holds the user id, and pointers like `#cboulanger` refer to it.
- The document status (`annotation.lifecycle.order`) is read from the **last** `revisionDesc/change` (`@status`, `@when` and `note[@type="label"]`, see `fastapi_app/lib/utils/tei_utils.py`). Line review must therefore **not** append `change` elements of its own: that would overwrite the status, the label and the revision date. The review summary goes into `standOff` instead (see below).
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
- Computed on the client from the parsed document the editor already keeps. Stored marks that match no unit any more are dropped on the next save.

## Storage

```xml
<TEI>
  <teiHeader>…</teiHeader>
  <standOff>
    <listAnnotation type="line-review">
      <note type="summary">units=184 ok=112 not-ok=8</note>
      <annotation xml:id="lr-cboulanger" motivation="assessing" target="#xpath(//text)" resp="#cboulanger">
        <revisionDesc><change when="2026-10-23T18:02:11Z"/></revisionDesc>
        <note type="reviewed-ok">3f9c2e1a 0b77d4a2 9e01c3f4 0b77d4a2.2 …</note>
        <note type="reviewed-not-ok">c41a07de …</note>
      </annotation>
      <annotation xml:id="lr-jdoe" motivation="assessing" target="#xpath(//text)" resp="#jdoe">
        <revisionDesc><change when="2026-10-23T19:40:02Z"/></revisionDesc>
        <note type="reviewed-not-ok">77e2b910 …</note>
      </annotation>
    </listAnnotation>
  </standOff>
  <text>…</text>
</TEI>
```

- There is one `annotation` per reviewer (`@resp`, `@xml:id="lr-<userid>"`), so marks are always attributable and never overwrite each other. The reviewer's `persName` is added to `respStmt` the way it is done for annotators. The `change` inside the annotation dates that reviewer's last marking. It is nested in the annotation and does not affect the document's `revisionDesc`.
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

## Combined view

- The gutter shows one state per unit, merged over all reviewers: **not OK** if any reviewer marked it not OK, otherwise **OK** if any reviewer marked it OK, otherwise unreviewed.
- Hovering a not-OK line shows a tooltip listing each reviewer's mark and its date, e.g. "✕ not OK · Jane Doe · 23 Oct 19:40 / ✓ OK · Christian Boulanger · 23 Oct 18:02". This makes disagreement visible without a separate view.
- Marking always changes only the current user's annotation. If another reviewer marked a unit not OK, the line stays red when you mark it OK. A not-OK mark goes away when its author changes it or when the unit is edited, which resets all marks (see [Open questions](#open-questions)).
- Not-OK units are listed in the diagnostics drawer with the reviewers' names.

## Workflow

1. A reviewer opens a document (normally in status `in-review`) and turns on **Review lines** in the XML editor toolbar. This shows the strip and enables the shortcuts and menu entries. Nothing changes for users who don't review.
2. The reviewer moves through the document. The PDF viewer follows the cursor as it does now (Autosearch).
3. Marking. Every action applies to the units under the cursor line, or to every unit the selection touches:
   - `Ctrl/⌘+Enter`: mark OK, then jump to the next unreviewed unit.
   - `Ctrl/⌘+Shift+Enter`: mark not OK, then jump.
   - `Ctrl/⌘+Shift+Backspace`: remove your mark.
   - `F7` / `Shift+F7`: next unreviewed unit / next not-OK unit. `F8` stays "next diagnostic".
   - Clicking the strip cycles your mark. Dragging marks a range OK, and Alt-dragging marks it not OK.
   - The gutter context menu (extending `xml-editor-context-menu.js`) offers: mark the selection, mark everything above the cursor, and pretty-print to resolve uncertain lines.
   - `Mod-Enter` (CodeMirror: `insertBlankLine`) is overridden only while review mode is on. Check the final keys against browser-reserved shortcuts before implementing.
4. Fixing: an annotator or reviewer edits a not-OK unit. Its fingerprint changes, so it becomes unreviewed until it is marked again. The strip shows a dashed bar and the tooltip says "was not OK (Jane Doe), edited since".
5. Marking makes the document dirty like any edit, and saving writes the annotations and the summary.
6. Progress shows in the status bar meter (P1), e.g. "112 OK · 8 not OK · 64 open". Clicking it jumps to the next open unit. The counts appear in the review queue and the file drawer (P4).
7. Before setting `approved`, the save dialog warns if there are not-OK or unreviewed units. This is a warning, not a block.

## Gutter colours

| State | Strip |
| --- | --- |
| Unreviewed | none |
| OK | green |
| Not OK | red |
| Edited since review (counts as unreviewed) | dashed, in the former colour |
| Uncertain (several units with different states, or loose text) | amber |

## Required changes

- fossil: allow `standOff/listAnnotation(note?, annotation*)` with `annotation(revisionDesc?, note*)` and its attributes in all training schemas.
- pte-plugins (GROBID): a review-unit XPath per variant.
- pdf-tei-editor:
  - frontend `line-review` plugin: gutter, state field, fingerprinting, keymap, context menu entries, status bar widget, linter source for the diagnostics drawer.
  - backend: parse `note[@type="summary"]` into file metadata for P4.

## Open questions

- Resolving disagreement: should a reviewer with the `reviewer` role be able to clear another reviewer's not-OK mark, keeping a trace of it? At the moment only the author or an edit removes it.
- Should a not-OK mark carry a short comment (a second `annotation` with `@motivation="commenting"` per unit)?
- When a document is saved as a new version (copy), are marks kept? The concept keeps them, since fingerprints re-validate themselves.

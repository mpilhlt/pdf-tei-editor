# Line review marking (concept)

Status: proposal, not implemented. Mockups: `line-review-marking/*.png` in the project files folder (rendered from `mockups.html`).

## Goal

Reviewers go through a document line by line and mark each line of the XML editor as **unreviewed**, **reviewed – OK** or **reviewed – not OK**. The state is shown in the CodeMirror gutter, survives saving, and tells everyone how much of a document has been reviewed.

## What the code base gives us

- `XMLEditor.createExtensionSlot()` (`app/src/modules/xmleditor.js`) gives a plugin its own reconfigurable compartment. A `line-review` plugin can add a `gutter()` with `GutterMarker`s and a `StateField` there without touching the core editor, like `xml-annotation` does.
- The diagnostics drawer (`app/src/plugins/diagnostics-drawer.js`) lists lint diagnostics. Lines marked not OK can be fed in as `info` diagnostics from a linter source, so they show up there and `F8` reaches them.
- The XML editor status bar (`app/src/modules/panels/status-bar.js` with the `status-*` widgets) takes a progress widget.
- Reviewers are already identified in the header: `respStmt/persName/@xml:id` holds the user id, and `change/@who="#id"` points to it. Document-level status (`annotation.lifecycle.order`, `in-review`, `approved` …) lives in `revisionDesc/change/@status`, and the `review_queue` plugin lists documents by that status. Line review is the fine-grained layer beneath that status.
- The fossil schemas (`schema/shared/tei-header.rng`) are strict: `TEI` allows only `teiHeader` and `text`, `revisionDesc` only `change` with `@status`, `@when`, `@who`. **Every storage option below needs a fossil schema change.**
- An editor "line" is very uneven in size. In reference-segmenter documents it is one `<bibl>`. In segmentation documents one line can hold a whole `<body>` paragraph with dozens of `<lb/>`, so it can wrap to 20 visual lines. The unit stays the logical CodeMirror line, as asked. Splitting long lines at `<lb/>` (which match PDF lines) is a possible later refinement.

## TEI practice

| Mechanism | What TEI means by it | Fit for line review |
| --- | --- | --- |
| `revisionDesc/change` with `@status`, `@who`, `@when` | Records a revision of the whole document and its status. | Good for a summary ("120 of 184 lines reviewed"), but not for per-line state. Already used by the app. |
| `@change` (att.global.change) on any element, pointing to a `change` | Assigns an element to a revision campaign or state. | The most idiomatic inline option. But it marks elements, not lines, and adds an attribute to every content element. |
| `@cert` / `@resp` (att.global.responsibility) | Certainty of the encoding and who is responsible for it. | Wrong meaning: it is about how sure the encoder was, not a review verdict. |
| `certainty`, `respons` (certainty module) | Stand-off statements about certainty of, or responsibility for, a `@target`. | `respons` could say who checked something, but it has no OK / not OK value. |
| `standOff` / `listAnnotation` / `annotation` with `@motivation`, `@target`, `@resp` | Stand-off annotation following the W3C Web Annotation model. `@motivation="assessing"` means "assess the target". `annotation` may contain `respStmt`, `revisionDesc` and `note`. | Best fit: stand-off, attributable per reviewer, and has a motivation built for this. |
| Processing instructions (oXygen `<?oxy_comment_start?>` etc.) | Tool-specific, outside TEI. | Schema-neutral, but it changes the very line text being reviewed and does not survive XSLT or GROBID round-trips. |

Prior art in tools works at page level, not line level: Wikisource uses page states (not proofread, problematic, proofread, validated), and Transkribus uses page statuses (in progress, done, final, ground truth). Line-level states in an XML editor gutter are new territory, so the convention below is ours.

## Recommendation: storage (S1)

```xml
<TEI>
  <teiHeader>
    …
    <revisionDesc>
      <change when="2026-10-23T18:02:11Z" status="in-review" who="#cboulanger">
        <desc>Line review: 120 of 184 lines (112 OK, 8 not OK)</desc>
      </change>
    </revisionDesc>
  </teiHeader>
  <standOff>
    <listAnnotation type="line-review">
      <annotation xml:id="lr-cboulanger" motivation="assessing" target="#text" resp="#cboulanger">
        <revisionDesc><change when="2026-10-23T18:02:11Z"/></revisionDesc>
        <note type="reviewed-ok">3f9c2e1a 0b77d4a2 9e01c3f4 0b77d4a2.2 …</note>
        <note type="reviewed-not-ok">c41a07de 77e2b910 …</note>
      </annotation>
    </listAnnotation>
  </standOff>
  <text xml:id="text">…</text>
</TEI>
```

- **Lines are identified by a fingerprint, not by number.** A fingerprint is a short hash (8 hex characters) of the line text after whitespace is trimmed and collapsed. Lines with the same text get `.2`, `.3` … in document order. This has several effects:
  - Editing a line changes its hash, so its old mark no longer matches and the line falls back to unreviewed. That also covers edits made outside the editor and merges between versions.
  - Inserting, deleting, moving or re-indenting other lines changes nothing.
  - Unreviewed is the default and is never stored.
  - Lines without text content (closing tags, blank lines, `<listBibl>`) are not reviewable and are not counted.
- **One `annotation` per reviewer** (`@resp`, `@xml:id="lr-<userid>"`), so marks from several people never overwrite each other. The reviewer's `persName` is added to `respStmt` the way the app already does for annotators.
- **`text` stays untouched.** GROBID training data and version diffs are not affected. The training export can drop `standOff`, or keep it, since it describes provenance.
- **The `revisionDesc/change` summary** is written on save. Readers who don't know the convention can still read it, and the backend can parse it for the dashboard and file lists without hashing anything.
- Size: about 9 bytes per reviewed line per reviewer, so about 4.5 KB for a 500-line document.
- Hashing runs on the client (the editor computes line text anyway). The backend only needs it to recompute counts, and can parse the `desc` or the note lengths instead.

### Rejected options

- **S2, inline `@change`**: as above, it marks elements and not lines, puts noise into training data and diffs, and needs schema and export changes in many places.
- **S3, processing instructions**: these change the line text being reviewed and get lost in round-trips.
- **App database only**: simplest to build, but the state would not travel with the TEI file, its versions or exports.

### Required changes outside the editor

- fossil: allow `standOff/listAnnotation/annotation(revisionDesc?, note*)` in the training schemas, and `@xml:id` on `text` (or point `@target` at `#xpath(//text)`, which needs no id).
- Save path: it is all client-side XML, so there are no backend changes beyond optional count parsing for the dashboard (`review_queue`, file drawer).

## Workflow

1. A reviewer opens a document (normally in status `in-review`) and turns on **Review lines** in the XML editor toolbar. This shows the status strip and enables the shortcuts and menu entries. Users who never review see no change.
2. The reviewer moves through the lines. The PDF viewer follows the cursor as it does now (Autosearch), so each line can be checked against the PDF.
3. Marking (all actions apply to the cursor line or to every line the selection touches):
   - `Ctrl/⌘+Enter`: OK, then jump to the next unreviewed line.
   - `Ctrl/⌘+Shift+Enter`: not OK, then jump.
   - `Ctrl/⌘+Shift+Backspace`: back to unreviewed.
   - `F7` / `Shift+F7`: next unreviewed line / next line that is not OK. `F8` stays "next diagnostic".
   - Clicking the strip cycles the state. Dragging in the strip marks a range OK, and Alt-dragging marks it not OK.
   - The gutter context menu (extending `xml-editor-context-menu.js`) has: mark the selection, mark the enclosing element (e.g. a whole `<listBibl>`), and mark everything above the cursor.
   - Overriding `Mod-Enter` (CodeMirror: `insertBlankLine`) only while review mode is on is acceptable. Check the final key choices against browser-reserved shortcuts before implementing.
4. Fixing: the reviewer, or an annotator later, can edit a line that is not OK. The edit changes its fingerprint, so the line becomes unreviewed (shown with a dashed strip and a tooltip "was OK/not OK by X, edited since") until someone marks it again.
5. Saving writes the reviewer's `annotation` and a summary `change`. Marking alone makes the document dirty like any edit.
6. Progress shows in the status bar meter (P1). The counts also appear in the review queue and the file drawer (P4).
7. Approval: a reviewer can only set `approved` when the combined view has no not-OK lines and no unreviewed lines. This can be a confirmation dialog rather than a hard block.

### Several reviewers

- By default you see and change only your own marks.
- "Show reviews of" switches between **Me**, **All reviewers** (one thin bar per reviewer in the strip, each line's tooltip listing who marked what and when) and **Combined**. In the combined view, not OK from anyone wins, then OK from anyone, otherwise unreviewed.
- Lines marked not OK appear in the diagnostics drawer with the reviewer's name, through a linter source registered with `XMLEditor.addLinter()`.

## UI alternatives (see the mockups)

| Area | Options | Recommendation |
| --- | --- | --- |
| Gutter | A status strip · B tinted line numbers · C icon column · D line background | **A**: narrow, does not clash with the active line, selection, diff or annotation highlights, and is a good drag target. C is the fallback for colour-blind users (a setting). |
| Marking | Toolbar toggle and buttons · context menu · keyboard · drag in the strip | All of them, acting on the same "cursor line or selection" set. |
| Progress | P1 status bar meter · P2 overview ruler · P3 toolbar badge · P4 document lists | **P1 and P4**. P2 is an optional add-on for long documents. |
| Several reviewers | Me / side by side / combined | Default **Me**, switchable. |
| Storage | S1 standOff annotation · S2 inline `@change` · S3 processing instructions | **S1** with fingerprints. |

## Open questions

- Should a not-OK mark carry a short comment? That would be a second `annotation` with `@motivation="commenting"` per line. The concept leaves it out for now.
- Should review marks be kept when a document is saved as a new version (copy), or reset? The proposal keeps them, since fingerprints re-validate themselves.
- For segmentation documents with very long lines, should the review unit be the `<lb/>`-delimited PDF line instead?

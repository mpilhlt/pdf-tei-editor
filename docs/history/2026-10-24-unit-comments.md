# Unit comments

Status: implemented (2026-10-24). User documentation: `docs/user-manual/unit-comments.md`.

## Goal

Let any user who can edit a document, annotators included, attach comments to elements instead of writing XML comments into the text. Comments live stand-off next to the review marks, in `TEI/standOff/listAnnotation[@type="unit-comment"]`, and reuse the unit review machinery (stand-off writing, fingerprints, gutter strip, popover, diagnostics).

## How comments differ from reviews

| Aspect | Unit review | Unit comment |
| --- | --- | --- |
| Target | Review units only (fixed by `unit-xpath`) | Any element: the innermost element at the right-clicked position or cursor |
| Granularity | One mark per unit and reviewer | Any number of comments per element, with replies |
| Who | Reviewers, admins | Everyone who can edit the document |
| Mode | Off by default (Review toggle) | Always shown when the document has comments; no mode |
| Edited target | Mark becomes stale (`was-*`) | Comment stays attached; its anchor is updated |
| Lifecycle | OK / not OK / final | Open / resolved |

## Storage

```xml
<standOff>
  <listAnnotation type="unit-comment" subtype="fp-sha256-8-v1">
    <annotation xml:id="uc-k3f9a2" motivation="commenting" target="#xpath(/TEI/text/back/listBibl/bibl[3])" resp="#jdoe">
      <revisionDesc>
        <change when="2026-10-24T09:00:00Z" who="#jdoe"/>
      </revisionDesc>
      <note type="fingerprint">b7d7ec9c</note>
      <note type="comment">Is "ibid." resolved correctly here?</note>
    </annotation>
    <annotation xml:id="uc-p81c0d" motivation="replying" target="#uc-k3f9a2" resp="#asmith">
      <revisionDesc>
        <change when="2026-10-24T09:12:40Z" who="#asmith"/>
      </revisionDesc>
      <note type="comment">Yes, it points to the previous entry.</note>
    </annotation>
  </listAnnotation>
</standOff>
```

- One `<annotation>` per comment. `motivation` is `commenting` for a new thread and `replying` for a reply, whose `@target` points to the thread's first comment (W3C Web Annotation motivations, as `assessing` for reviews).
- The anchor is twofold: `@target` holds an XPath to the element, `note[@type="fingerprint"]` the fingerprint of its content (same algorithm as review units). On load, the comment attaches to the element with that fingerprint closest to the XPath; if none matches, to the element at the XPath; if that does not exist either, the comment is *detached* and only listed in the diagnostics drawer.
- Resolving appends `<change status="resolved" who=… when=…/>` to the thread's `revisionDesc`; reopening appends `status="open"`. The last change counts.
- Commenters are listed in `respStmt` like reviewers (shared code).
- The fossil schema already allows this structure (`schema/shared/stand-off.rng`); only its header comment needs a line about `unit-comment`.

## User interface

- **Add a comment**: a separate **Comment…** item in the right-click menu (not in the Review row), and the shortcut `Ctrl+Shift+M` (`Cmd+Shift+M`). It opens the comment prompt below the element. Comments attach to elements only, not to text ranges.
- **Indicator**: a speech bubble in the gutter strip column on the element's first line (blue when open, grey when resolved), next to or instead of the review colour. If both apply to the same line, the strip shows the review colour and a small bubble overlay. The element's start tag gets a light underline while its thread is open.
- **Thread popover**: clicking the bubble opens the thread (author, time, text), a reply field, and **Resolve** / **Reopen**. Authors can edit or delete their own comments; admins can delete any.
- **Diagnostics drawer**: every open thread is an `info` diagnostic of source `unit-comment` with the first comment as message and the actions **Reply** and **Resolve**. Detached threads appear too, marked as such. `F8` (next diagnostic) already reaches them. No hover tooltip in the text, so as not to repeat the popover's buttons (as for reviews now).
- **Status bar**: "3 open comments"; clicking it goes to the next open thread.
- **Save Revision dialog**: a **Keep comments** checkbox, checked by default, next to **Clear reviews** for new versions. Unchecked, the new version starts without comments.
- **Converting XML comments**: a TEI Wizard command turns the XML comments inside `<text>` into unit comments on their parent element (the commenter is the current user) and removes them from the text.

## Shared machinery

Before adding the comment plugin, the generic parts of `app/src/plugins/unit-review.js` move into modules that both plugins use:

- `modules/standoff-list.js`: find or create `standOff/listAnnotation[@type]`, write it back as one undoable edit, keep `standOff` folded, maintain `respStmt`.
- `modules/node-anchor.js`: element fingerprints and the XPath-plus-fingerprint anchor resolution (review units keep their fingerprint-only matching).
- `modules/unit-review-popover.js` becomes a generic stand-off popover with a review body and a thread body.
- The diagnostics merging with the re-entry guard, and the right-click position (`pos`) in the context menu.

## Permissions and read-only documents

Adding a comment changes the document, so it needs the same write access as any edit (own version or lock). The standOff edit guard for non-admins only blocks typing; programmatic writes from the plugin pass, so annotators can comment although they cannot edit `standOff` by hand. In annotation mode, commenting is allowed (like reviewing).

On documents the user cannot write (for example a gold version without lock), the **Comment…** item is disabled with the tooltip "Create your own version to comment".

## Decisions (Christian, 2026-10-24)

1. Comments attach to elements only.
2. Existing XML comments can be converted into unit comments (TEI Wizard command).
3. New versions: separate **Keep comments** checkbox in the Save Revision dialog, checked by default.
4. Shortcut: `Ctrl+Shift+M` (`Cmd+Shift+M`).

## Implementation notes

Differences from the proposal above and details settled during the implementation:

- Shared code moved out of the unit review plugin: `modules/standoff-list.js` (locate, read and write a `listAnnotation` of a type in one transaction, keep `standOff` folded, add the user's respStmt). Element anchors are in `modules/node-anchor.js`, the comment data model in `modules/unit-comments.js`, the thread popover in `modules/unit-comment-popover.js` (built on the review popover's mechanics), the gutter in `modules/codemirror/unit-comment-gutter.js`. The `unit-comments` plugin ties them together.
- The comments have their own narrow gutter (speech bubbles) between the review strip and the line numbers, not an overlay on the review strip. It is only part of the editor while the document has comments.
- The creation of a comment is the first `change` without `@status`; `status="open"` is only written when a thread is reopened. Edits add `status="edited"`.
- Anchors: besides XPath and fingerprint, the plugin tracks each element's position through the edits of the session, so a comment stays on its element even when the element is edited and moved in the same session. Changed anchors are written back (not undoable separately) after edits.
- Diagnostics shown only in the drawer: `lint-utils.drawerOnlyDiagnostics(source)` replaces the per-plugin lint filters of the review plugin, because two lint gutter configurations with filters cannot be combined. Both plugins re-merge their diagnostics only when another source removed them, otherwise they would re-merge in turn.
- Annotators' edit guard (`//tei:text` only) now lets undo and redo through, so they can undo their comments.
- The TEI Wizard conversion (`convert-xml-comments.js`) attaches a comment directly before an element to that element, other comments to their parent. It writes no fingerprint; the editor adds it the next time it writes the comments.
- The fossil schema (`schema/shared/stand-off.rng`) accepts the structure as is.

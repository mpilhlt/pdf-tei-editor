# Unit comments: proposal

Status: proposal, not implemented (2026-10-24).

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
        <change when="2026-10-24T09:00:00Z" who="#jdoe" status="open"/>
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

- **Add a comment**: a separate **Comment…** item in the right-click menu (not in the Review row), and a keyboard shortcut. It opens the comment prompt below the element. Candidate shortcut: `Ctrl+Shift+M` (`Cmd+Shift+M`), to be checked against browser shortcuts (Firefox's responsive design mode uses it with devtools open).
- **Indicator**: a speech bubble in the gutter strip column on the element's first line (blue when open, grey when resolved), next to or instead of the review colour. If both apply to the same line, the strip shows the review colour and a small bubble overlay. The element's start tag gets a light underline while its thread is open.
- **Thread popover**: clicking the bubble opens the thread (author, time, text), a reply field, and **Resolve** / **Reopen**. Authors can edit or delete their own comments; admins can delete any.
- **Diagnostics drawer**: every open thread is an `info` diagnostic of source `unit-comment` with the first comment as message and the actions **Reply** and **Resolve**. Detached threads appear too, marked as such. `F8` (next diagnostic) already reaches them. No hover tooltip in the text, so as not to repeat the popover's buttons (as for reviews now).
- **Status bar**: "3 open comments"; clicking it goes to the next open thread.
- **Save Revision dialog**: a **Clear resolved comments** option next to **Clear reviews** for new versions.

## Shared machinery

Before adding the comment plugin, the generic parts of `app/src/plugins/unit-review.js` move into modules that both plugins use:

- `modules/standoff-list.js`: find or create `standOff/listAnnotation[@type]`, write it back as one undoable edit, keep `standOff` folded, maintain `respStmt`.
- `modules/node-anchor.js`: element fingerprints and the XPath-plus-fingerprint anchor resolution (review units keep their fingerprint-only matching).
- `modules/unit-review-popover.js` becomes a generic stand-off popover with a review body and a thread body.
- The diagnostics merging with the re-entry guard, and the right-click position (`pos`) in the context menu.

## Permissions and read-only documents

Adding a comment changes the document, so it needs the same write access as any edit (own version or lock). The standOff edit guard for non-admins only blocks typing; programmatic writes from the plugin pass, so annotators can comment although they cannot edit `standOff` by hand. In annotation mode, commenting is allowed (like reviewing).

On documents the user cannot write (for example a gold version without lock), the **Comment…** item is disabled with the tooltip "Create your own version to comment".

## Questions for Christian

1. Elements only, or also text ranges inside an element (with character offsets in the anchor)? Elements keep the anchors simple and robust; ranges can be added later.
2. Should existing XML comments be convertible into unit comments (one-off command in the TEI Wizard)?
3. Keep comments of a new version by default (proposed), or start without them like a clean copy?
4. Shortcut: `Ctrl+Shift+M`, or another proposal?

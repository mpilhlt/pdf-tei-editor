# Unit Comments

Unit comments let you attach a comment to an element of the document (for example a `<bibl>`), instead of writing an XML comment into the text. Other users can reply, and anyone who can edit the document can resolve the comment when it is dealt with. Annotators can comment too.

Comments are stored in the document, so they are saved with it, can be undone with `Ctrl+Z` and are kept when a new version is created (unless you choose otherwise, see below).

## Adding a comment

Right-click an element and choose **Comment…** at the top of the context menu, or put the cursor in the element and press `Ctrl+Shift+M` (`Cmd+Shift+M` on macOS). Type the comment and press `Enter`; `Esc` cancels.

The comment belongs to the innermost element at the position you clicked: right-clicking the text of a `<title>` inside a `<bibl>` comments on the `<title>`. Click on the `<bibl>` tag itself to comment on the whole entry. Comments can only be attached to elements, not to parts of a text.

You need write access to the document to start a comment: on a read-only document (for example a gold version you do not own), create your own version first. Replying works without write access, see below.

Type `@` to mention someone: the people listed in the document's `respStmt` and its owner are offered for completion. A mentioned user receives the comment as a [message](messages.md).

## Seeing comments

- A **speech bubble** left of the line numbers marks the first line of each commented element: blue while the comment is open, grey when it is resolved. A small number shows how many comments start on that line. Hover over the bubble to read them.
- The **status bar** shows the number of open comments. Click it to go to the next one.
- Open comments are listed in the **diagnostics drawer**, with the buttons **Reply** and **Resolve**. `F8` jumps to the next entry there.

## Replying, resolving, editing

Click the bubble to open the comment. The popover shows the comment and its replies, with the author and time of each.

| Action | How |
| --- | --- |
| Reply | Type in the reply field and press `Enter` or **Reply**. Replying to a resolved comment reopens it. |
| Reply in a read-only document | With view access and the *annotator* or *reviewer* role you can reply in documents you cannot edit, such as someone else's version or a gold file. The reply is saved to the document right away. |
| Resolve / reopen | **Resolve** or **Reopen** |
| Edit your comment | **Edit** next to it, change the text, `Enter` |
| Delete | **Delete** next to a comment; deleting the first comment deletes the replies too. You can delete your own comments, admins any comment. |

Replies reach the author of the thread and the users mentioned earlier in it as [messages](messages.md). When someone replies to a document you have open, the reply appears in your editor without a reload. If you save your copy afterwards, other users' comments and replies that are missing from it are kept (administrators' saves are taken as they are).

## When the element changes

A comment stays with its element when you edit the element's content or when elements are inserted or removed before it. If the element is deleted, the comment is listed in the diagnostics drawer as "Element not found"; open it with **Reply** to delete it.

## New versions

When saving a revision to a new personal version, the Save Revision dialog offers **Keep comments** (checked by default). Uncheck it to start the new version without comments; the original keeps its comments.

## Converting XML comments

The TEI Wizard (wand icon) has an enhancement **Convert XML comments** that turns the XML comments (`<!-- … -->`) inside `<text>` into unit comments by you and removes them from the text. A comment directly before an element (only whitespace in between) is attached to that element; any other comment to the element that contains it.

## How the comments are stored

The comments are stored in `TEI/standOff/listAnnotation[@type="unit-comment"]`, next to the [unit review](unit-review.md) marks. The `<standOff>` is folded and only admins can edit it by hand.

Each comment is an `<annotation>`. A new comment (`motivation="commenting"`) points to its element with an XPath and records a fingerprint of the element's content, which finds the element again after it moved. A reply (`motivation="replying"`) points to the comment it answers. The `<revisionDesc>` of the first comment records its creation and each time it was resolved or reopened.

```xml
<standOff>
  <listAnnotation type="unit-comment" subtype="fp-sha256-8-v1">
    <annotation xml:id="uc-k3f9a2" motivation="commenting" target="#xpath(/TEI/text/back/listBibl/bibl[3])" resp="#jdoe">
      <revisionDesc>
        <change when="2026-10-24T09:00:00Z" who="#jdoe"/>
        <change when="2026-10-24T09:20:00Z" who="#asmith" status="resolved"/>
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

An edited comment gets a `<change status="edited"/>`.

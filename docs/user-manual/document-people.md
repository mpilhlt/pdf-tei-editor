# People of a Document

The **People** button (group icon) in the XML editor toolbar, next to *Edit header metadata*, opens a dialog with the persons involved in the current document.

## The list

The dialog lists the persons of the document's `/TEI/teiHeader/fileDesc/titleStmt/respStmt` elements:

| Column | Content |
| --- | --- |
| Name | The `persName` of the `respStmt`, followed by its `xml:id`, which is the user name for users of the editor |
| Responsibilities | The `resp` elements, for example *Annotator*, *Reviewer*, *Commenter*. Several `respStmt` elements of one person are shown as one entry |
| Edits | The revisions (`revisionDesc/change`) whose `@who` names the person |
| Comments | The [unit comments](unit-comments.md) and replies the person wrote |
| Message button | Sends the person a short message (see below) |

The editor adds a `respStmt` itself when someone saves a revision, sets [review marks](unit-review.md) or writes a comment.

## Adding people

Users with the *reviewer* or *admin* role see an **Add a person** section below the list, enabled while the document can be edited:

1. Pick a user from the user database.
2. Pick a responsibility. Only the responsibilities that match the user's roles are offered: *Annotator* requires the *annotator* role, *Reviewer* the *reviewer* role, *Commenter* only the *user* role that every user has. Responsibilities the person already has are not offered.
3. Click **Add**. The person is added to the `titleStmt` as a `respStmt` (or the responsibility to the person's existing `respStmt`), and the document is saved.

Adding a person does not change who can access the document, which is governed by [access control](access-control.md). Added persons can be [mentioned](messages.md#mentions) in comments.

## Sending a message

Click the message button of a person to open a one-line field below the entry. Type the message (at most 500 characters) and press `Enter` or **Send**. The message appears in the recipient's [Messages](messages.md), where it opens the document, and can be answered from there. It is **not stored in the document**.

The button is disabled for yourself and for persons who are not users of the editor. A message can only be sent to a user who can view the document.

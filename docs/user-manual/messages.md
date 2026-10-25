# Messages

Messages tell you about feedback on your work without having to open each document. You receive a message when:

- a reviewer marks a unit of a document you own as **not OK** (see [Unit Review](unit-review.md)). If the reviewer marks their own copy of your version instead, the message still reaches you: it goes to the nearest owner in the version history who is not the reviewer,
- someone **mentions** you in a [unit comment](unit-comments.md) with `@yourname`,
- someone replies to a comment thread you started, or to a thread in which you were mentioned earlier,
- you have the *reviewer* role and someone saves a revision of a document with the status **in-review**. The message shows the revision's description. Further in-review revisions in a row keep the same message; a new one is created only after the status changed to something else and back to in-review.

Your own marks and comments never create messages for you.

## Unread count

The number of unread messages is shown as a red badge on the user menu button in the toolbar, and again on the **Messages** item of the user menu. It updates live when new messages arrive.

## The Messages dialog

Open it with **Messages** in the user menu.

| Control | Effect |
| --- | --- |
| Unread / All | Show only unread messages, or all of them |
| Kind | Reviews (including review requests), comments, or both |
| Mark all as read | Marks every message as read |
| Envelope button on a row | Mark this message as read or unread |
| Reply | Reply without leaving the dialog |
| Load more | Shows the next 50 messages |

Click a message to open its document at the source: a comment opens with its thread popover, a review opens with review mode on and the unit's review popover, a review request opens the document with review mode on. Opening a message marks it as read.

A message with a grey note is **settled**: the comment thread was resolved, the not-OK mark was changed to OK, the unit was edited after the review, a newer LLM review replaced the earlier one, or the status of a document under review changed from in-review. Settled messages are kept, so you can still look them up.

### Replying

Review requests have no reply button.

- **To a comment**: your reply is added to the comment thread, also in documents you cannot edit, as long as you have the *annotator* or *reviewer* role and the version is not superseded. Replying to a resolved thread reopens it. If the document is open in someone else's editor, the reply appears there right away.
- **To a review**: you start a new comment thread on the reviewed unit that mentions the reviewer, so the reviewer receives your answer as a message.

## Mentions

Type `@` in a comment, a reply or the comment of a not-OK mark to get a list of the people you can mention: the persons in the document's `respStmt` entries and the owner of the document. Pick one with the arrow keys and `Enter` or `Tab`, or with the mouse. Mentions of known users are shown as highlighted chips.

The mention is the user name (for example `@jdoe`). An `@` inside a word, such as in an e-mail address, is not a mention.

## Copies of a document

The same comment or mark can exist in several versions of a document, for example after a new version was created from an annotated one. It is shown as one message, which opens the newest copy.

LLM Reviewer runs on one document are shown as one message ("flagged N units"), which opens at the first not-OK unit.

## For administrators

The messages are kept in an index (`messages.db` in the database directory) that is updated whenever a document is saved or deleted. It is built at the first server start. If it is out of date, for example after files were changed on disk, rebuild it with:

```bash
npm run manage-remote -- maintenance rebuild-messages
```

Read states are kept across a rebuild.

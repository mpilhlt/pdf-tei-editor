# Document rule overrides in read-only documents

The document rule editor's sync status line ("Machine rules outdated: the guide changed since the last sync") links to **Update from guide**, and "both changed" links to **Mark as in sync**. Both links, the **Update from guide** button, **New override**, **Save**, the note field and the pair's **Propose change upstream** button were hidden or disabled when the document was read-only. The warning then gave no way to act on it.

Overrides are per user (`DocumentRulesStore`, keyed by owner and resource) and proposals go to the guide repository; neither changes the document. The server gates these endpoints by role only (`require_reviewer_or_admin`), and the editor is only offered to reviewers and admins. So the client-side read-only gate had no reason.

Change (`app/src/plugins/document-rules.js`): overrides, Update from guide, Mark as in sync and Propose change upstream no longer depend on `_documentReadOnly`. What changes the document stays gated: Update to upstream (button, link, prompt on open) and the on-load drift check that runs Refresh document rules.

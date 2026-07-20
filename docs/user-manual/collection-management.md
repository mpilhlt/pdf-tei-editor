# Projects and Collections

## Overview

The PDF-TEI Editor organizes documents in a two-level hierarchy: **projects** contain **collections**, and your membership in a project determines which collections you can see and work with.

- A **collection** is a named set of documents (e.g. a processing batch, a thematic group, or a user's personal workspace).
- A **project** bundles one or more collections together and lists the users who have access to them. You can only see collections that belong to at least one project you are a member of.

Admins configure projects, collections, and memberships. For that setup workflow, see the [RBAC Manager administrator guide](rbac-manager.md).

## What You Can See

When you open the document selector, the collection dropdown shows only the collections accessible to you. If a collection does not appear in the list, you are not a member of any project that includes it — contact an administrator.

Every new document extracted from a PDF lands in the **Inbox** (`_inbox`) collection by default. From there it can be moved to a more specific collection once processing is under way.

## Moving and Copying Documents Between Collections

Documents are moved or copied in batch from the **Collection & Files** drawer. Open it with the drawer button in the toolbar.

### Selecting documents

The drawer shows all collections and their documents in a tree. Each document and each collection has a checkbox:

- Check individual document rows to add them to the selection.
- Check a collection's checkbox to select all documents in that collection at once. The collection checkbox reflects partial selections with an indeterminate state.
- Use **Select all/none** at the top of the tree to select or deselect every document in one click.

### Running the move or copy

Once at least one document is checked, the **Move or copy** button (<sl-icon name="folder-symlink"></sl-icon>) in the drawer footer becomes active.

1. Click the <sl-icon name="folder-symlink"></sl-icon> button to open the batch Move/Copy dialog.
2. Choose **Move** or **Copy** and select one or more destination collections. Only collections you have write access to are shown.
3. Confirm — the operation runs immediately for all selected documents.

A **move** removes each document from its current collection. A **copy** leaves the original in place and adds it to the target collection as well.

The result is visible to all users who have access to the destination collection.

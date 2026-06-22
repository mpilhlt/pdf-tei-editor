# Projects and Collections

## Overview

The PDF-TEI Editor organizes documents in a two-level hierarchy: **projects** contain **collections**, and your membership in a project determines which collections you can see and work with.

- A **collection** is a named set of documents (e.g. a processing batch, a thematic group, or a user's personal workspace).
- A **project** bundles one or more collections together and lists the users who have access to them. You can only see collections that belong to at least one project you are a member of.

Admins configure projects, collections, and memberships. For that setup workflow, see the [RBAC Manager administrator guide](rbac-manager.md).

## What You Can See

When you open the document selector, the collection dropdown shows only the collections accessible to you. If a collection does not appear in the list, you are not a member of any project that includes it — contact an administrator.

Every new document extracted from a PDF lands in the **Inbox** (`_inbox`) collection by default. From there it can be moved to a more specific collection once processing is under way.

## Moving Documents Between Collections

Use the **Move files** button (<sl-icon name="folder-symlink"></sl-icon>) in the Document toolbar to relocate the current document.

1. Click the <sl-icon name="folder-symlink"></sl-icon> button to open the Move Files dialog.
2. Choose a destination collection from the dropdown. Only collections you have write access to are shown.
3. Optionally, type a new collection name to create it on the fly.
4. Confirm — the document and its related files are moved immediately.

The move is visible to all users who have access to the destination collection.

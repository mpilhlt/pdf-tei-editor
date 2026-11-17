# Renaming the ids of users, projects and collections

Issue: #801

## Goal

Admins can rename the ids of users, projects and collections in the "Manage Access & Projects" dialog. The rename replaces the id everywhere the application stores it.

## Decision

TEI documents are not rewritten (Christian, 2026-11-17). Their `respStmt/persName/@xml:id`, `@who`, comment authors and `@mentions` keep the username that was current when they were written. Rewriting them would change the content hash of every version, including gold files, and mark all of them for synchronization. The annotator's full name, which the UI shows, is stored in the document.

Consequence: the message index is derived from the TEI files. After a user rename, the renamed rows in `messages.db` stay, but reindexing a document that mentions the old username creates no message for the new one.

## Implementation

- `fastapi_app/lib/utils/rename_utils.py`: `rename_user()`, `rename_project()`, `rename_collection()` validate the new id (format, uniqueness) and return the number of changed records per store.
  - User: `users.json`, project members, collection owners, `files.created_by`, `document_permissions.owner`, `sessions.username` (the user stays logged in), access token owner and creator, user secrets, bookmarks, message recipients and authors.
  - Project: `projects.json` (config overrides are part of the project), the `rbac.default-project` setting.
  - Collection: `collections.json`, collection lists of projects and groups, `files.doc_collections` (deleted files included; synced files are marked as modified).
- Store methods: `FileRepository.rename_created_by()`, `FileRepository.rename_collection()`, `rename_document_owner()`, and `rename_user()` on `SessionManager`, `AccessTokenStore`, `SecretStore`, `BookmarkStore`, `MessageStore`.
- Endpoints (admin only): `POST /api/v1/users/{username}/rename`, `POST /api/v1/projects/{project_id}/rename`, `POST /api/v1/collections/{collection_id}/rename` with body `{"new_id": "..."}`; 400 invalid id, 404 unknown entity, 409 id taken. They emit the event bus events `user.renamed`, `project.renamed`, `collection.renamed` (`old_id`, `new_id`) for plugins with their own stores.
- Frontend: entity schemas declare `renamable`, `idPattern` and `renameHint`; `EntityManager.rename()`; a **Rename** button in the form header opens a nested rename dialog.
- Frontend extension points `rbac.{user,project,collection}Renamed` (`oldId`, `newId`) and `rbac.{user,project,collection}Relabeled` (`id`, label), invoked by the RBAC manager after a rename or after a saved change of the full name or name (review on PR #810: reload the menus without tight coupling). `FiledataPlugin` reloads file data, collections and projects on project and collection changes; `FileSelectionPlugin` moves the collection filter to a renamed collection; `AuthenticationPlugin` refreshes `state.user` when the logged-in user was renamed or relabeled.
- Collection order (review on PR #810): `FiledataPlugin` stores `state.collections` and the `collections` of each project sorted by display name, with numbers compared by value (`sortCollections()`, `sortProjectCollections()` in `app/src/modules/collection-utils.js`). Before, the Collection menu and the Collections & Files drawer listed the collections of a project in the order of `projects.json`, so renaming ids did not change the order.

## Follow-up

Plugins in mpilhlt/pte-plugins that store usernames or collection ids (e.g. revision-feed tokens, mpcdf-llm per-user sessions, webdav-sync remote metadata) can subscribe to the rename events.

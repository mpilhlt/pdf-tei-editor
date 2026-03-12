# Document Search Plugin

## Overview

The Document Search plugin provides metadata search across all documents accessible to the current user. Open it via the search button (magnifying-glass icon) in the toolbar.

You can search within the labels of the PDF and TEI documents, wich contain author, year and title of the document in the PDF, or the title of the annotation. In addition, the results of the search can be filtered by selected other metadata fields, like "collection" or "status".

Results show matching documents with the matched text highlighted. Clicking a result opens that document in the editor.

The search is against document metadata, full-text search in the documents is not supported yet, and probably not a common use case.

Use **Refresh index** to rebuild the search index after new documents have been added.

---

## Search Syntax

### Plain text

Type any word or phrase. Results are ranked by relevance. Multi-word input matches all terms (AND logic).

```
brahms symphony
```

Quoted phrases match exactly:

```
"string quartet"
```

### DSL metadata filters

Certain database fields can be filtered directly using a `field:value` syntax. All filters are combined with AND. They can be mixed freely with plain text terms.

#### Basic filter

```
status:published
is_gold_standard:true
```

#### Negated filter (`:not:`)

```
status:not:published
is_gold_standard:not:true
```

#### OR values (pipe `|`)

```
status:published|in-review
status:not:published|in-review
```

#### Combined with text search

```
is_gold_standard:true status:not:published brahms
```

---

## Filter reference

| Field | Type | Accepted values |
| ----- | ---- | --------------- |
| `is_gold_standard` | boolean | `true`, `1`, `yes` → gold standard; anything else → not gold standard |
| `status` | string | Any status value stored in the TEI `revisionDesc` (e.g. `published`, `in-review`, `draft`). Case-sensitive. |
| `variant` | string | Variant identifier stored in the TEI metadata. Case-sensitive. |
| `created_by` | string | Username of the file's creator. Case-sensitive. |
| `collection` | string | Collection ID. Matches documents belonging to any of the specified collections. |

---

## Technical summary

- The search index is built on first use per session and held in an in-memory SQLite database.
- When SQLite FTS5 is available (the default), full-text search uses a virtual FTS5 table with prefix-wildcard matching. When FTS5 is unavailable, a LIKE-based fallback is used.
- `is_gold_standard` and `status` are stored as UNINDEXED columns in the FTS5 table, enabling SQL-level filtering without affecting the full-text index.
- DSL filter tokens are parsed out of the query string before it is passed to the FTS engine. Filter-only queries (no text terms) skip the FTS MATCH predicate entirely.
- The index covers all TEI files accessible to the user, regardless of gold-standard status.
- The index is invalidated (and the in-memory database closed) when the search window is closed or when the user clicks **Refresh index**.
- Authentication uses the session ID passed as a query parameter or `X-Session-ID` header.

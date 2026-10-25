# Frozen versions and a text hash chain (discussion for #207)

Status: implemented, 2026-10-24. See [Implementation](#implementation) for what differs from the proposal.

## How history works today

- Each TEI file is a version. **Save Revision** appends a `revisionDesc/change` to the open file. With **Save to new copy**, the change goes into a new file, so the new file's changes are the old file's changes plus one.
- Between revisions, autosave changes the text without adding a `change`.
- Ancestry is a heuristic: `build_version_ancestry_chains()` in `fastapi_app/lib/utils/tei_utils.py` treats B as derived from A when A's `(who, when, status)` signatures are a proper prefix of B's.
- History is a tree, not a line. Two annotators who both copy v1 make sibling versions.

Editing A after B was copied from it either appends a change to A, so A is no longer a prefix of B and B loses its parent, or changes A's text silently. Either way A becomes the most recently edited file. That breaks the "newest occurrence" rule of the messages spec and the dashboards that sort by `updated_at`.

## Proposal

### 1. Freeze by descendant, not by version number

A file is **frozen** when another file descends from it. A lower version number alone does not freeze a file.

- Freezing every lower number would block parallel work. Alice's v2 and Bob's v3, both copied from v1, are siblings, so Bob's copy must not lock Alice out.
- Frozen state is derived, never stored: `frozen(f) = exists g with parent(g) = f`. Deleting the only descendant unfreezes the parent, so "undo new version" keeps working.
- Frozen files are **fully immutable**: text, header and `standOff`. Reviews and comments only change on leaf files, which matches the messages spec's newest-occurrence rule. Old marks stay visible, read-only.
- To change a frozen file, the user creates a new version from it, which is a new branch.

### 2. Hash of `TEI/text` in each `change`

- Each `change` records the hash of the canonical content of `TEI/text` at the moment of the revision. `teiHeader` and `standOff` are left out, because they change for legitimate reasons after a revision: reviews, comments, replies, respStmt.
- Canonical form: the same normalisation as the unit-review fingerprint (whitespace and indentation insensitive, entity encoding normalised). Reformatting then does not count as an edit.
- Chained: `h(n) = sha256(h(n-1) + canon(text))`, truncated to 16 hex characters. Storage: `change/@xml:id="h-<hash>"`, as #207 proposes. `@xml:id` is unique within a document, which a chain value is. Alternative: `@corresp` or a custom attribute, if the schema prefers.
- **The server computes the hash**, in `files_save.py`, for the last `change` when it has none. One implementation, and the client cannot write a wrong value.

### What the chain gives

- **Exact ancestry:** `parent(g)` is the file whose last hash is the hash of `g`'s second-to-last change. This replaces the signature heuristic and is stored as `parent_stable_id` in `metadata.db` when the new version is created.
- **Edited since last revision:** if `canon(text)` differs from the head hash, the file has unrevised edits. This is useful for UI ("unsaved revision") and is not an error.
- **Detection of edits to frozen files outside the app** (sync, manual file edits): the text no longer matches the head hash, and the chain of a descendant no longer contains it.

What it does **not** give is protection against deliberate falsification. Anyone with the XML can recompute an unkeyed chain. A server-keyed HMAC would fix that, but then files lose verifiability outside the server. Given the stakes, the plain chain is enough: it catches accidents and makes ancestry exact.

### 3. Enforcement

- Backend: `files_save.py` rejects saves to frozen files with 409 ("Superseded by version X. Create a new version to edit."). This also closes part of the ownership gap noted in the messages spec.
- Frontend: frozen files open read-only, with a status bar note naming the descendant and offering "Open latest" / "New version from this".
- Lock endpoint: no locks on frozen files.
- Admin override: none needed. Deleting the descendant unfreezes the parent.

### 4. Migration

- Existing files: compute the hash for the **last** change of each file only. Earlier states cannot be reconstructed. Mark the older changes as unverified.
- `parent_stable_id` for existing files comes from the signature heuristic, run once.
- Files where the heuristic finds an ancestor whose text has diverged are reported in a maintenance log. They are not repaired automatically.

## Effect on the messages spec

- "Newest occurrence" becomes "the leaf in the recipient's branch" instead of the latest `updated_at`. That is more robust.
- The reply endpoint always targets a leaf. Replies in frozen files are impossible by construction.
- A thread or mark that exists only in a frozen file (for example, **Keep comments** was unchecked) is historic: listed as settled, opened read-only.

## Effect on version lists (Christian, 2026-10-24)

- The XML version dropdown and the file drawer list only leaves, one per branch, plus gold (always shown, even when frozen).
- Frozen versions are reached through a "Show history" toggle in the drawer and through the ancestry view (annotation progress), both read-only.
- Opening a frozen version from a bookmark or URL still works, read-only, with "Open latest" in the status bar.
- Version counts in document lists count leaves.

## Decisions (Christian, 2026-10-24)

1. Gold freezes like any other version once a version is derived from it. Fixing gold means a new version, then promoting it.
2. Frozen files are fully immutable, `standOff` included.
3. The hash goes into `change/@xml:id="h-<hash>"`, only on `/TEI/teiHeader/revisionDesc/change`. The fossil schema needs `@xml:id` on `change`; it currently allows only `status`, `when` and `who`.
4. No keyed HMAC.

## Prerequisite fix: header changes vs. stand-off changes

The unit-review and unit-comment annotations have their own `revisionDesc/change`. Several places read `//revisionDesc/change` without restricting to `teiHeader` and pick up those changes too:

- `extract_last_revision_status()` and `extract_revision_timestamp()` (`fastapi_app/lib/utils/tei_utils.py`), used by `files_repopulate.py` and migrations m005/m006. Verified: for a document whose last header change is `in-review` and that has a resolved comment, they return `resolved` and the comment's date.
- `extract_change_signatures()`, the basis of the current ancestry chains: comment and review changes become part of the signature list.
- `app/src/plugins/tei-tools.js:232` (`querySelectorAll('revisionDesc change')`), `app/src/modules/tei-utils.js:186` (labels), and the fallback at line 142, which appends to the stand-off `revisionDesc` when the header has none.

The save path (`extract_tei_metadata()`) is not affected; it takes the first `revisionDesc`. Fix: one helper per language returning `/TEI/teiHeader/revisionDesc/change`, used everywhere. This must come before the hash chain.

## Implementation

- `fastapi_app/lib/utils/revision_hash.py`: canonical text (C14N without comments, whitespace runs collapsed, whitespace next to tags removed), `h(n) = sha256(h(n-1) + "\n" + canon(text))[:16]`, and `stamp_revision_hashes()`.
- Stamping, in `files_save.py`: the editor buffer never holds the hash ids, so they are copied back from the reference file (the stored file, or the source of a new version) by matching `(who, when, status)`. Only the last header change gets a new hash, and only if it is not in the reference file. Ids are inserted with a regex, so the rest of the document is unchanged. When the number of `change` start tags in the header differs from the parsed changes (`listChange`), nothing is stamped.
- `files.parent_stable_id` (migration m010) is set when a new version is saved from a file of the same document. For existing files, m010 derives it from the longest proper prefix of the change signatures within (doc_id, variant), leaving ambiguous cases unset.
- Frozen = a non-deleted file has `parent_stable_id` equal to the file's stable_id. The file list returns `parent_id` and `is_frozen` per artifact. Saves to frozen files return 409, locks 403, and the document-rules refresh refuses them.
- Frontend: `isFrozenFile()` in `acl-utils.js`; `canEditFile()` returns false for frozen files, for admins too. The access-control plugin sets the editor read-only with the status text *Read-only (superseded by a newer version)*, also when the open file becomes frozen by "save to new version". The revision dialog forces *Save to a new personal version* for frozen files.
- The file drawer hides frozen versions, except gold and the open file. The "Target XML" menu first did the same; Christian then asked for it to list all versions like the compare menu, so that old versions can be opened and copied (2026-10-24).
- The "Target XML" and "Compare with version" menus group versions by lineage (Christian, 2026-10-24): the current versions that share a parent, then their frozen ancestors, joined to them by a CSS-drawn line with an arrow pointing up (classes `lineage-ancestor`, `lineage-ancestor-last`, `lineage-arrow` in `app.css`), then a divider before the next lineage (`groupVersionsByLineage()` in `file-data-utils.js`).

Differences from the proposal:

- No "Show history" toggle and no "Open latest" button. The compare menu keeps listing frozen versions, which is the way to look at them.
- The migration does not stamp hashes into existing files. Legacy files get a hash with their next revision; older changes stay without one.
- `parent_stable_id` is taken from the save request's source file, not from the hash chain. The hash chain is not yet used for ancestry or to report diverged files.
- Version counts in document lists are unchanged.

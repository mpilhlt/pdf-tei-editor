# Document rules: clean up after a merged upstream proposal

Part of #666. Builds on phases 1–4b (two-layer rules, sync markers, "Propose upstream" with patch download and GitHub pull request).

## Intent

A reviewer edits rules as personal overrides, proposes them upstream from the "Propose upstream" dialog, and the maintainer merges the pull request. Afterwards the reviewer's state is stale in two ways:

- the document's `<ref target>`s are still pinned to the commit before the merge;
- the overrides that went into the pull request are now redundant: upstream contains their text.

Today the only follow-up is "Reset to original" in the rule editor. It re-pins the category's refs, but it deletes only the shown layer's overrides (a paired proposal changed both layers), deletes them without checking whether upstream actually contains them, and nothing tells the reviewer that the cleanup is due.

This feature makes the follow-up visible and safe: the rule editor shows which overrides upstream now contains, and one action brings the category up to date, removing only those overrides.

## Goals

- In the rule editor, each override of the shown category (both layers) is marked when its text matches the section on the guide's default branch ("In upstream").
- The editor says when the document's pinned refs of the category are behind the default branch.
- One action, "Update to upstream", for the category: re-pins the human and machine refs to the current upstream commit, deletes the overrides of both layers that match upstream, and keeps the rest.
- Overrides that still differ from upstream (proposal not merged yet, merged with edits, never proposed) are kept and remain usable.

## Non-goals

- No notice in the header status bar and no check on document load. That is the user's broader request ("display a message in the header status bar if the document rules are outdated…"), postponed to a later phase.
- No change to how proposals or pull requests are made.
- No tracking of pull request state (open/merged) via the GitHub API; the text comparison is the signal.
- `schema` resources: out of scope; they have no pinned commit and no upstream proposal flow.

## Anti-goals

- Deleting an override whose text upstream does not contain. Losing unmerged work would be worse than leaving a redundant override.
- Leaving a deleted override selected (the document must fall back to "Original", i.e. the re-pinned upstream text).

## Decisions made with the user

- The cleanup is for the case after the pull request was merged.
- An override that differs from upstream is kept.
- The check covers all of the user's overrides of the category, not only the selected one; both layers.
- Scope is the rule editor; the status bar notice comes later.

## How "matches upstream" is decided

For a layer (human or machine) with pinned URL `u`:

- Upstream text: the section of `u` at the head of the guide repository's default branch (the forge adapter's `url_at_default_branch()`, then the usual section extraction).
- An override matches when its text equals the upstream text after normalisation:
  - links in the same form (overrides use absolute same-repo links, `absolutize_markdown_urls`; compare both sides absolutized against the default-branch URL);
  - every sync marker line (`<!-- sync: … -->`, wherever it appears) is removed from both sides before comparing: the proposal recomputed it upstream, the override keeps its old one; whole-text comparison otherwise (my call);
  - trailing whitespace per line and leading/trailing blank lines are ignored.
- Per layer (my call): if a layer's upstream text cannot be determined (fetch failure, or the section no longer resolves at the default branch head), none of that layer's overrides is marked or deleted, and the editor says why; the other layer is unaffected. The re-pin still runs if the refs are behind.

"Refs behind" is one value per category (my call): the existing per-resource refresh (`plan_resource_refresh`, used by "Reset to original") re-pins all layers of the category together and reports `changed`.

## Rule editor behaviour

- When the editor opens a two-layer category (or a single-layer interpretation-ref resource), it requests the upstream status of the category: per layer, whether the refs are behind, and for each of the user's overrides whether it matches upstream.
- Override buttons that match upstream get a distinct icon and the tooltip "Upstream contains this text; it is removed when you update to upstream." This applies on both layer tabs.
- A status line (next to the existing sync status line) appears when refs are behind or any override matches upstream, e.g. "The guide upstream has changed. Update to upstream to use it; 2 overrides that upstream now contains will be removed."
- The "Update to upstream" button replaces "Reset to original" for interpretation-ref resources. It is shown whenever refs are behind or an override matches upstream (not only when an override is selected, as "Reset to original" is now). It asks for confirmation, naming how many overrides are removed and how many are kept. Then it:
  1. re-pins the category's refs in the document (the existing "Reset to original" document edit, unchanged);
  2. deletes the matching overrides of both layers;
  3. resets the selection of a layer to "Original" if its selected override was deleted; a selected override that is kept stays selected;
  4. reloads the editor and the override indicators.
- Kept overrides whose `base_hash` no longer matches the new original show the existing "outdated" clock marker, as today.
- Schema resources keep "Reset to original" unchanged.

## Backend

Overrides are per user (the `owner` of the store); both routes act only on the caller's own overrides.

- `POST /document-rules/upstream-status`, gated like the other editing routes (`require_reviewer_or_admin`), plain `def` (network work). Input: the document's stable id (`xml`, as in the refresh routes; read access suffices) and the pinned URL of one layer of the category. The server derives the category's layers from the document (`InterpretationRefKind.discover()` on the stored TEI, the descriptor group containing that URL); a URL that is not among the document's refs is a 400, so the route cannot be used to fetch arbitrary URLs (my call). Output: `refs_behind` (category), and per layer: `layer`, `url`, `error` (why upstream could not be determined, else null) and the ids of the caller's overrides that match upstream.
- `POST /document-rules/remove-overrides-in-upstream`, same gate and input. It recomputes the match server-side at call time and deletes exactly the caller's overrides of the category that match upstream now, resets a layer's selection to the original when its selected override was deleted, and returns the deleted ids and the ids kept (my call: this replaces a client-side re-check, so a stale status can never delete an override upstream does not contain).
- Order in "Update to upstream": the client first re-pins the document (existing document edit; a failure stops before anything is deleted), then calls the removal route with the new pinned URL. Removal is one transaction-free sequence of per-override deletes; if one fails, the route stops and returns 502 with what was deleted so far, and the client reloads and reports it (my call).
- The confirmation dialog uses the counts of the last status call; the success message reports the counts the removal route returned, which can differ (my call).

## Left to the builder

- Exact copy of the status line, button tooltip and confirmation text, within the meaning above.
- Icon choice for "In upstream".
- Caching of the default-branch fetch (the existing `UrlCache` and forge adapter caching apply).

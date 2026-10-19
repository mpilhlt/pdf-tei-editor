# Login dashboard

After login, a dialog shows a dashboard of boxes that plugins contribute. A host plugin (`dashboard`) owns the dialog and the layout; guest plugins contribute boxes through a frontend extension point. Of the mockups made for this work, concept A (modal dialog) was chosen.

## Behaviour

- The dialog opens automatically once per login, not on every page reload, and only if at least one box is contributed. It can be disabled per user ("Show on login" checkbox) and globally (config `plugin.dashboard.show-on-login: false`).
- An info button in the toolbar, between the "Collection & files" drawer button and the search button, reopens it.
- The dialog title is the user's full name (or username). The former "Welcome back" toast after login was removed.
- Two columns. Each box declares its width (1 or 2 columns), height (rows) and priority. Boxes are placed by priority, but the order may be bent so that no cell stays empty. Overflowing content scrolls inside its box. A box can have a link at the right end of its title bar ("See all").
- Archived projects, and documents in collections that belong only to archived projects, are excluded from all boxes. Collections and projects are shown by name.
- Document rows show the document (PDF) label as text and the TEI label as a link that opens the document.

Boxes:

| Box | Plugin | Content | cols | rows | priority |
| --- | --- | --- | --- | --- | --- |
| Recently edited | `recent-documents` (new) | Up to five documents per project last saved by the user | 1 | 1 per 4 lines, max 4 | 100 |
| Recent edits | `edit-history` | The ten latest changes in all accessible projects, who made them, "See all" link | 1 | 1 per 4 edits, max 3 | 70 |
| Waiting for review | `review-queue` (new) | Documents whose status is in a configurable list; reviewers and admins only | 1 | 1 per 4 documents, max 3 | 60 |
| Annotation progress | `annotation-progress` | Per project and collection, progress of each variant towards a configurable status | 1 | 1 per 5 lines, max 4 | 50 |

## Host plugin and core changes

### `dashboard` plugin (`fastapi_app/plugins/dashboard/`)

Backend: metadata only (`required_roles: ["user"]`); `initialize()` registers `extensions/dashboard.js`. `documents.py` holds helpers for the guests' routes:

- `DocumentInfoResolver(file_repo, archived_collections)`: `entry(tei_file)` returns `stable_id`, `pdf_stable_id`, `doc_id`, `title` (PDF label, falling back to the PDF title, the TEI title and the doc_id), `label` (TEI label or `None`), `variant` and `collections` without archived ones; `is_archived(tei_file)` is true if the file has collections and all of them are archived.
- `project_includes(project, collections)` (wildcard projects contain all collections) and `project_specificity(project)` (sort key: fewest collections first, wildcard projects last), used to list a document only under its most specific project, because projects often share collections.

Frontend extension `dashboard` ([extensions/dashboard.js](../../fastapi_app/plugins/dashboard/extensions/dashboard.js)):

- Extension point `dashboard.contributions`. Handlers may be async and return an array (empty when there is nothing to show) of:

  ```javascript
  /** @typedef {{ id: string, title: string, icon?: string, element: HTMLElement, cols?: 1|2, rows?: number, priority?: number, action?: { label: string, onClick: () => void } }} DashboardContribution */
  ```

  Contributions are collected with `invokePluginEndpoint`; a failing handler is logged and skipped.
- Showing after login: `ready()` (called after the last document has been restored) and `onSessionIdChange()` call `#showAfterLogin()`. It opens the dialog unless the config key or the user's checkbox (UIStorage `showOnLogin`) is off, or it was already shown for the current session id (UIStorage `shownForSession`). A login while the app is running therefore shows it again; a reload does not.
- Toolbar button `ui.toolbar.dashboardBtn` (`info-circle`, data-test-id `dashboard-toolbar-btn`), contributed through `toolbar.contentItems` in the left zone with priority 9.5, between the file drawer button (10) and the search button (9). Hidden while no user is logged in (`onUserChange`).
- Packing (`packDashboard`, exported for unit tests):
  1. Sort by priority, descending (stable).
  2. One-column box: goes into the shorter column.
  3. Two-column box: if the columns differ by `gap` rows, take the first remaining one-column box whose `rows === gap` and put it into the shorter column; if there is none, stretch the last box of the shorter column. Then place the box across both columns.
  4. At the end, stretch the last box of the shorter column to level both.
  If the shorter column has no box since the last full-width box (for example a single one-column box), the boxes of the taller column are widened to both columns instead.
  The result is a CSS grid (`1fr 1fr`, row height `minmax(90px, 1fr)`, grid height `min(65vh, rows × 150px)`); box bodies scroll.
- Helpers for guests (via `getDependency('dashboard')`): `close()`, `openDocument(xml, pdf, collection)` and `renderDocumentList(groups)`. The list is one CSS grid per list with a subgrid per row, so the columns (PDF label, TEI label, detail, status badge, relative time) line up across groups; unused columns are dropped, the TEI label column is `fit-content(40%)` and the detail column `fit-content(25%)`, labels are cut with ellipses. Below 600px list width (a one-column box) a container query switches to two-line rows: PDF label and time, then link, detail and status.

### Core changes

- `app/src/plugins/start.js`: removed the "Welcome back" toast.
- `app/src/plugins/toolbar.js`: `dashboardBtn` in the toolbar typedef.
- `document_search` extension: contributes its button through `toolbar.contentItems` (left, priority 9) instead of inserting it after the drawer button in `start()`, whose result depended on startup timing.
- `fastapi_app/routers/files_save.py`: new event `document.saved` (`stable_id`, `doc_id`, `username`) after each successful save. The existing `document.save` fires before the write and has no `stable_id` for new versions.
- `project_utils.get_visible_projects(user, db_dir)`: non-archived projects of the user, all of them for admins (`*` role). `project_utils.get_archived_collection_ids(db_dir)`: collections that belong only to archived projects (mirrors the frontend's `getArchivedCollectionIds()`).
- `FileRepository.get_tei_files_by_status(statuses)`: non-deleted TEI files with one of the statuses, newest first.
- E2E fixture configs set `plugin.dashboard.show-on-login` to `false`, so the dialog does not cover the UI in unrelated tests.
- Docs: `document.save`/`document.saved` in `docs/development/class-dependencies.md`, a pointer to the dashboard README in `docs/code-assistant/plugin-communication.md`.

## Guest plugins

Plugins whose only purpose is a box declare `"dependencies": ["dashboard"]`. Existing plugins with other functions do not, since disabling the dashboard would deactivate them; without the host nobody invokes their extension point.

### `recent-documents` (new, `fastapi_app/plugins/recent_documents/`)

- The files table records only the creator, not who saved last. The plugin keeps its own record in `data/plugins/recent_documents/recent_edits.json` (`{"seeded": bool, "users": {username: {stable_id: iso_timestamp}}}`, at most 300 files per user), updated on `document.saved` and protected by a thread lock and a file lock. On first initialization it is seeded from `created_by` / `updated_at`.
- `GET /api/plugins/recent-documents/recent`: per project from `get_visible_projects()`, the five documents (one entry per `doc_id`) the user saved most recently, each under its most specific project only. Projects are sorted by their newest edit; projects without edits are omitted.
- Box: one group per project; clicking the TEI label opens the document.

### `review-queue` (new, `fastapi_app/plugins/review_queue/`)

- `required_roles: ["reviewer", "admin"]`; config `plugin.review-queue.statuses` (default `["in-review"]`).
- `GET /api/plugins/review-queue/documents`: empty for users without the reviewer or admin role; otherwise the accessible, non-archived documents (per variant) whose most recently updated TEI file has one of the statuses, newest first. Documents that moved on in a newer version are not listed. The box shows no project.

### `annotation-progress` (existing, new extension)

- `GET /api/plugins/annotation-progress/dashboard-summary`: `{threshold, projects: [{id, name, batches: [{id, name, total, variants: [{variant, done}]}]}]}`. `done` counts documents with a TEI file of the variant whose `status` is at or after `plugin.annotation-progress.dashboard-threshold` (default `approved`) in `annotation.lifecycle.order`; no XML parsing. Each collection appears once, under its most specific project; archived collections are skipped.
- Box ("ring rows", concept A of the compact-layout mockups): one line per collection with one small progress ring per variant, in the same variant order on every line of a project, and a percentage per project. A tooltip names the variant and the counts; clicking a ring closes the dashboard and opens the existing progress view for that collection and variant.

### `edit-history` (existing, new extension and routes)

- `GET /api/plugins/edit-history/recent?limit=10`: TEI files in the collections of the projects from `get_visible_projects()`, archived ones skipped. Only the `2 × limit` most recently updated files are read; the last `revisionDesc/change` of each is extracted with the existing `_extract_revision_info()` and the result is sorted by `@when`.
- `GET /api/plugins/edit-history/all`: the existing DataTables page for the same set of files ("Edit History - All Projects"), opened by the new plugin endpoint `show_all` (also in the backend plugins menu).
- Box "Recent edits": PDF label, change description as the link (opens the document), who, status, time; "See all" closes the dashboard and runs `show_all`.
- The box was first built in `annotation_history`, which works per document and was the wrong host; that plugin only gained a README.

## Tests

- JS unit tests (run with `node --test`; like the other plugin `*.test.js` files they are not part of `npm run test:unit`): `packDashboard` and the after-login logic in `dashboard/tests/`, and the contribution building of each guest extension in its plugin's `tests/` directory.
- Python tests: the edit store and route of `recent_documents`, the route of `review_queue` (statuses, newer versions, archived, roles), `annotation_progress`'s summary and `edit_history`'s `/recent` and `/all` (access, archived, admin, limit). `dashboard/tests/fixtures.py` provides a temporary file repository for them.
- E2E (`tests/e2e/tests/dashboard-plugin.spec.js`): not shown on login when disabled; toolbar button order; the button opens the dialog with one box per contribution; the guests' routes answer for the logged-in user.

## Commits

One commit for the host plugin and the core changes (including this document and the E2E test, which also checks the guests' routes), then one commit per guest plugin, and one for the annotation history README.

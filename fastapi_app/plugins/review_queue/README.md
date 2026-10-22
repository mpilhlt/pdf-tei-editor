# Review Queue Plugin

Contributes a "Waiting for review" box to the [dashboard](../dashboard/README.md) listing, for users with the reviewer or admin role, all documents they can access whose lifecycle status is one of the configured statuses. Each row shows the document (PDF) label and the TEI label; clicking the TEI label opens it.

## Configuration

| Key | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `plugin.review-queue.statuses` | `PLUGIN_REVIEW_QUEUE_STATUSES` | `["in-review"]` | Lifecycle statuses (from `annotation.lifecycle.order`) of the listed documents, as a JSON array |

The environment variable sets the initial value when the key is not yet in `config.json`.

A document is listed per variant, and only if its most recently updated TEI file has one of the statuses, so documents that moved on in a newer version disappear from the list. Documents in collections that belong only to archived projects are not listed.

## Route

`GET /api/plugins/review-queue/documents` returns `{statuses, documents}`, newest first.

Depends on the `dashboard` plugin.

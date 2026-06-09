# Collection Config API Audit

Endpoints that could benefit from per-collection config overrides.

## Endpoints that take `collection` and could use collection config

| Endpoint | Collection param | Config keys |
| --- | --- | --- |
| `POST /files/upload` | `collection` query param | `access-control.default-visibility`, `access-control.default-editability` |
| `POST /extract` | via file's `doc_collections` | `annotation.lifecycle.*`, `schema.base-url` |
| `GET /files/access_control_mode` | `collection` query param (added in Task 10) | `access-control.default-visibility`, `access-control.default-editability` |
| `GET /files/permissions/{stable_id}` | via file's `doc_collections` (added in Task 10) | `access-control.default-visibility`, `access-control.default-editability` |

## Endpoints that don't provide collection but could benefit

| Endpoint | Notes |
| --- | --- |
| `GET /config/list` | Already fixed in Task 2 — accepts optional `collection` query param |
| `GET /validation` | `schema.base-url` could vary per collection; no collection param currently |
| `POST /files/repopulate` | `annotation.lifecycle.*` could vary per collection; no collection param currently |

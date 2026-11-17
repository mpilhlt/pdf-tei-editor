# Owner-based access control as default (#796)

## Change

`access-control.mode` now defaults to `owner-based`, the mode that the user manual describes for the multi-annotator workflow:

- `config/config.json`: default value `owner-based`
- `fastapi_app/lib/permissions/acl_utils.py`: `get_access_control_mode()` falls back to `owner-based`
- `app/src/plugins/access-control.js`: fallback mode (no mode loaded, mode request failed) is `owner-based`
- `.env.development`, `.env.production`: comments on `ACCESS_CONTROL_MODE`
- User manual and developer documentation of the modes

Existing instances are not affected: `db_init` only merges missing keys from `config/config.json` into `data/db/config.json`, so an instance that already has `access-control.mode` keeps its value.

## Fix: reviewers could not delete documents of others in owner-based mode

`POST /files/delete` and `POST /files/delete_history` checked `check_file_access(..., 'write')`, i.e. edit rights. In owner-based mode only the owner (and admins) may edit, so reviewers got a 403 when deleting a version of an annotator, contrary to the documented rule ("Only reviewers and document owners can delete files"). Both routes now check `'delete'`, which uses `can_delete_document()`: reviewers and admins can delete, other users only their own documents. In role-based mode this means that annotators can no longer delete versions of other annotators, which is what the documentation already stated.

## Fix: documents without an owner were read-only for reviewers in owner-based mode

The backend lets reviewers edit documents without an owner (e.g. imported files) in owner-based mode, but `AccessControlPlugin.canEditDocument()` required `owner === username`, so the frontend made them read-only, showed the "has no owner" toast and the save dialog forced a new copy. The frontend now follows the backend rule: `canEditDocument()`, the owner-based toast and the forced copy in `DocumentActionsPlugin.saveRevision()` treat ownerless documents as editable by reviewers (and admins).

## Tests

`tests/api/v1/access_control_modes.test.js`: the owner-based reviewer and admin tests referenced a never-created `userOwnedFileId`; they now use the annotator-owned file. The access control, save, delete, permissions and freeze API tests pass in all three modes (`--env ACCESS_CONTROL_MODE=<mode>`).

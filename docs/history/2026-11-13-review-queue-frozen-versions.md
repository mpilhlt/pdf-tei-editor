# Review queue: skip frozen versions

A document showed up in the dashboard's "Waiting for review" box although newer versions had been copied from its `in-review` version. The queue listed a document if its most recently updated TEI file had a configured status. A frozen version (one that other versions were copied from) can still have a newer `updated_at` than its copies, so it could win that comparison.

Change: `fastapi_app/plugins/review_queue/routes.py` ignores frozen versions (`FileRepository.get_frozen_stable_ids()`), both as candidates and when choosing the most recently updated version of a document variant. The `in-review` status in the frozen version stays, as part of its history.

The queue also listed the user's own versions. It now skips versions whose owner (`created_by`) is the current user, since those wait for someone else's review.

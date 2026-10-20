# Plugin READMEs

Added a short `README.md` to each backend plugin in `fastapi_app/plugins/` that had none, following the structure of `fastapi_app/plugins/annotation_progress/README.md` (features, usage, routes, implementation files, technical details). Content is taken from each plugin's `plugin.py`, `routes.py` and supporting modules.

Plugins covered: `active_sessions`, `anthropic_llm`, `collection_overview`, `edit_history`, `google_llm`, `llamore_extractor`, `revision_feed`, `rng_converter`, `test_plugin`, `update_metadata`.

`annotation_history` is excluded because its README is added in a separate PR.

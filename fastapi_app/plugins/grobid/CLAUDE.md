# GROBID Plugin — Code Assistant Notes

## Tests

Plugin tests live in `fastapi_app/plugins/grobid/tests/`. JavaScript tests are run via the backend test runner:

```bash
node tests/backend-test-runner.js --test-dir fastapi_app/plugins/grobid/tests
```

Python unit tests must be run manually using the Python test runner:

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_config.py -v
```

**All new tests for this plugin go in `fastapi_app/plugins/grobid/tests/`**, not in `tests/unit/`.

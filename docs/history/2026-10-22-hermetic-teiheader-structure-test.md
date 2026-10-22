# Hermetic teiHeader structure test, offline fallback

Date: 2026-10-22

## Problem

`TestTeiHeaderStructureEndpoint::test_merges_document_schema_with_core_fallback` declared `https://example.org/missing-schema.rng` as the document schema and let `download_schema_file()` hit the network. Online, example.org answers 404, which `resolve_document_schema_cache_file()` turns into `HTTPException(404)` and the endpoint falls back to the core schema. Offline (e.g. the cloud sandbox, which blocks the host), the download raises a non-404 `ValidationError`, which the endpoint did not catch, so the request failed with a 500.

So the test was network-dependent, and it also exposed a real defect: without internet, `/validate/teiheader-structure` failed for any document whose schema is not cached, although its comment claimed to handle "unreachable" schemas.

## Changes

- The test mocks `download_schema_file()` with the 404 error, so it covers the same path without network access. Skipping when offline was not chosen, since a mock keeps the coverage everywhere.
- New test `test_unreachable_document_schema_falls_back_to_core` mocks a connection failure.
- `generate_teiheader_structure()` also catches `ValidationError` and falls back to the core schema.

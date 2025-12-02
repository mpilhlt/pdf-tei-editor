# Extractor Integration Tests

This directory is reserved for dedicated integration tests of real extractors:

- `grobid.test.js` - Grobid extractor integration tests (requires GROBID_SERVER_URL)
- `llamore.test.js` - LLamore/Gemini extractor tests (requires GEMINI_API_KEY)
- `rng.test.js` - RNG schema validation extractor tests

These tests are separate from the main test suite because they:
- Require external services or API keys
- Are slow (LLM calls, network requests)
- Are non-deterministic (LLM responses vary)
- Should run in CI only when credentials are available

## Why Not in Main Test Suite?

The main extraction tests ([../extraction.test.js](../extraction.test.js)) use the mock extractor for:
- Fast execution (<5 seconds)
- Deterministic results
- No external dependencies
- Reliable CI/CD pipeline

Real extractor tests should verify:
- External service integration
- API authentication
- Error handling for service failures
- Output quality and structure

## Running Extractor Integration Tests

```bash
# Grobid extractor (requires running Grobid server)
export GROBID_SERVER_URL=http://localhost:8070
npm run test:api -- --grep grobid

# LLamore/Gemini extractor (requires API key)
export GEMINI_API_KEY=your-api-key-here
npm run test:api -- --grep llamore

# RNG extractor (no external dependencies)
npm run test:api -- --grep rng
```

**Status**: Not yet implemented (Phase 9c placeholder)

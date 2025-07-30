# Test Suite

This directory contains tests for the PDF-TEI Editor application using Node.js built-in test runner.

## Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm run test:sync

# Run tests with coverage (Node 20+)
node --test --experimental-test-coverage tests/*.test.js
```

## Test Files

- **sync-algorithm.test.js** - Comprehensive tests for the XML syntax tree <-> DOM synchronization algorithm, including processing instruction handling

## Test Structure

Tests use Node.js built-in test runner (Node 18+) with:
- `describe()` for organizing test suites
- `test()` for individual test cases
- `assert` module for assertions
- `jsdom` for DOM simulation in Node.js environment

## Key Test Scenarios

### Processing Instructions
- XML documents with processing instructions before root element
- Mixed content (processing instructions, comments, elements)
- Edge cases with processing instruction-only documents

### Synchronization Algorithm
- Basic element mapping between syntax and DOM trees
- Error handling for mismatched tag names
- Child element count validation
- Empty document handling

## Writing New Tests

When adding new test files:
1. Use `.test.js` extension
2. Import `test`, `describe` from `node:test`
3. Import `assert` from `node:assert`
4. Follow the existing pattern for mock setups
5. Add meaningful test descriptions and assertions
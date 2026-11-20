#!/usr/bin/env node

/**
 * Unit tests for the full-text search of the user manual: sections, matching, ranking, snippets, the result list and
 * the highlighting on the page.
 * @testCovers app/src/modules/manual-search.js
 * @testCovers app/src/modules/manual-search-box.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;
global.window = /** @type {any} */ (dom.window);
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;

const { createMarkdownRenderer } = await import('../../../app/src/modules/markdown-utils.js');
const { buildIndex, fold, highlightParts, parseQuery, search, snippet, splitSections } =
  await import('../../../app/src/modules/manual-search.js');
const { markSectionMatches, clearSectionMarks } = await import('../../../app/src/modules/manual-search-box.js');

const md = createMarkdownRenderer();
const pluginMd = createMarkdownRenderer({ html: false });

const REVIEW = `# Review Workflow

Intro about the review of documents.

## Disputed units

A unit is disputed when votes are tied.

## Rules of thumb

Keep one personal version. A unit stays disputed until the reviewer accepts.

\`\`\`bash
npm run manage-remote
\`\`\`

<!-- plugin-docs: review -->
`;

const TOKENS = `# Personal Access Tokens

## Creating a token

Open the user menu.

## Using a token

Put the token in the .env file.
`;

const TUTORIAL = `# LLM Reviewer tutorial

## Step 1: Start

Résumé of the steps; disputed findings are discussed.
`;

function index() {
  return buildIndex([
    { path: 'user-manual/review-workflow.md', markdown: REVIEW },
    { path: 'user-manual/access-tokens.md', markdown: TOKENS, title: 'Personal Access Tokens' },
    { path: 'plugins/grobid/docs/tutorial.md', markdown: TUTORIAL, title: 'How to use the LLM Reviewer', source: 'GROBID', description: 'Check training documents part by part.' }
  ], page => page.source ? pluginMd : md);
}

describe('fold and parseQuery', () => {
  it('lowercases, removes diacritics and splits on hyphens', () => {
    assert.strictEqual(fold('Résumé-Unit_Review'), 'resume unit review');
  });

  it('parses words and quoted phrases', () => {
    assert.deepStrictEqual(parseQuery('"Unit review" token'), { words: ['unit', 'review', 'token'], phrases: ['unit review'], folded: 'unit review token' });
  });
});

describe('splitSections', () => {
  it('splits by headings and keeps text and code, not HTML comments', () => {
    const sections = splitSections(md, REVIEW);
    assert.deepStrictEqual(sections.map(s => [s.heading, s.level, s.anchor]), [
      ['Review Workflow', 1, 'review-workflow'],
      ['Disputed units', 2, 'disputed-units'],
      ['Rules of thumb', 2, 'rules-of-thumb']
    ]);
    assert.strictEqual(sections[0].text, 'Intro about the review of documents.');
    assert.match(sections[2].text, /npm run manage-remote/);
    assert.doesNotMatch(sections[2].text, /plugin-docs/);
  });

  it('keeps text before the first heading as a section without heading', () => {
    const sections = splitSections(md, 'Before\n\n# Title\n\nAfter\n');
    assert.deepStrictEqual(sections.map(s => [s.heading, s.text]), [['', 'Before'], ['Title', 'After']]);
  });
});

describe('search', () => {
  it('ranks a heading match above body text matches and groups by page', () => {
    const [first, ...rest] = search(index(), 'disputed');
    assert.strictEqual(first.path, 'user-manual/review-workflow.md');
    assert.deepStrictEqual(first.sections.map(s => s.anchor), ['disputed-units', 'rules-of-thumb']);
    assert.strictEqual(first.sections[0].snippet, '');
    assert.match(first.sections[1].snippet, /disputed/);
    assert.deepStrictEqual(rest.map(p => p.path), ['plugins/grobid/docs/tutorial.md']);
    assert.strictEqual(rest[0].source, 'GROBID');
  });

  it('ranks the page title highest', () => {
    const [first] = search(index(), 'access token');
    assert.strictEqual(first.path, 'user-manual/access-tokens.md');
    assert.strictEqual(first.sections[0].anchor, '');
    assert.ok(first.sections[0].score > first.sections[1].score);
  });

  it('matches word prefixes and words spread over heading and page title', () => {
    assert.strictEqual(search(index(), 'tok creat')[0].sections[0].anchor, 'creating-a-token');
    assert.deepStrictEqual(search(index(), 'personal using').map(p => p.sections[0].anchor), ['using-a-token']);
  });

  it('requires quoted phrases', () => {
    assert.strictEqual(search(index(), '"votes are tied"')[0].sections[0].anchor, 'disputed-units');
    assert.deepStrictEqual(search(index(), '"tied votes"'), []);
  });

  it('finds plugin page descriptions and ignores diacritics', () => {
    assert.strictEqual(search(index(), 'training documents')[0].path, 'plugins/grobid/docs/tutorial.md');
    assert.strictEqual(search(index(), 'resume')[0].path, 'plugins/grobid/docs/tutorial.md');
  });

  it('lists all pages for an empty query', () => {
    assert.deepStrictEqual(search(index(), '  ').map(p => p.title), ['Review Workflow', 'Personal Access Tokens', 'How to use the LLM Reviewer']);
  });

  it('limits pages and sections', () => {
    const result = search(index(), 'the', { maxPages: 1, sectionsPerPage: 1 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sections.length, 1);
  });
});

describe('snippet and highlightParts', () => {
  it('cuts the text around the first match at word boundaries', () => {
    const text = `${'word '.repeat(40)}the needle is here ${'tail '.repeat(40)}`.trim();
    const result = snippet(text, ['needle'], 40);
    assert.match(result, /^… .*needle.* …$/);
    assert.ok(result.length < 60);
  });

  it('marks word starts only', () => {
    assert.deepStrictEqual(highlightParts('Review the reviewers, not preview', ['review']), [
      { text: 'Review', match: true },
      { text: ' the ', match: false },
      { text: 'review', match: true },
      { text: 'ers, not preview', match: false }
    ]);
  });
});

describe('markSectionMatches', () => {
  it('marks the query words in the section of a heading only, and removes the marks again', () => {
    const container = document.createElement('div');
    container.innerHTML = md.render(REVIEW);
    const heading = container.querySelector('#disputed-units');
    assert.strictEqual(markSectionMatches(container, heading, ['disputed']), 2);
    assert.deepStrictEqual([...container.querySelectorAll('mark')].map(m => m.closest('h2, p')?.tagName), ['H2', 'P']);
    clearSectionMarks(container);
    assert.strictEqual(container.querySelectorAll('mark').length, 0);
    assert.match(container.textContent ?? '', /A unit is disputed when votes are tied/);
  });
});

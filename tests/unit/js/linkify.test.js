#!/usr/bin/env node

/**
 * Unit tests for turning URLs in plain text into links.
 * @testCovers app/src/modules/linkify.js
 * @testCovers app/src/modules/mention-autocomplete.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;
const { splitUrls, linkifyNodes } = await import('../../../app/src/modules/linkify.js');
const { renderWithMentions } = await import('../../../app/src/modules/mention-autocomplete.js');

/**
 * @param {string} text
 * @returns {Array<string|[string, string]>} Plain parts as strings, URLs as [text, url]
 */
function parts(text) {
  return splitUrls(text).map(p => p.url ? [p.text, p.url] : p.text);
}

describe('splitUrls', () => {
  it('splits a text at a URL', () => {
    assert.deepStrictEqual(parts('see https://github.com/mpilhlt/fossil/issues/78 now'), [
      'see ', ['https://github.com/mpilhlt/fossil/issues/78', 'https://github.com/mpilhlt/fossil/issues/78'], ' now'
    ]);
  });

  it('returns a text without URLs as one plain part', () => {
    assert.deepStrictEqual(parts('no links here.'), ['no links here.']);
    assert.deepStrictEqual(parts(''), []);
  });

  it('excludes trailing punctuation', () => {
    assert.deepStrictEqual(parts('See https://example.com/path.'), ['See ', ['https://example.com/path', 'https://example.com/path'], '.']);
    assert.deepStrictEqual(parts('https://a.example/x?, or'), [['https://a.example/x', 'https://a.example/x'], '?, or']);
    assert.deepStrictEqual(parts('"https://a.example/x"'), ['"', ['https://a.example/x', 'https://a.example/x'], '"']);
  });

  it('excludes unbalanced closing brackets but keeps balanced ones', () => {
    assert.deepStrictEqual(parts('(see https://a.example/x)'), ['(see ', ['https://a.example/x', 'https://a.example/x'], ')']);
    assert.deepStrictEqual(parts('https://en.wikipedia.org/wiki/Foo_(bar).'), [
      ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'], '.'
    ]);
  });

  it('keeps query strings and fragments', () => {
    const url = 'https://example.com/a?b=1&c=2#d';
    assert.deepStrictEqual(parts(`${url} x`), [[url, url], ' x']);
  });

  it('only links http(s) URLs with a host', () => {
    assert.deepStrictEqual(parts('javascript:alert(1) ftp://a.example https:// mailto:a@b.org'), [
      'javascript:alert(1) ftp://a.example https:// mailto:a@b.org'
    ]);
  });

  it('does not let markup end up in the URL', () => {
    assert.deepStrictEqual(parts('https://a.example/x"onclick="y <b>'), [['https://a.example/x', 'https://a.example/x'], '"onclick="y <b>']);
  });

  it('links several URLs', () => {
    assert.deepStrictEqual(parts('https://a.example vs http://b.example'), [
      ['https://a.example', 'https://a.example'], ' vs ', ['http://b.example', 'http://b.example']
    ]);
  });
});

describe('linkifyNodes', () => {
  it('builds text nodes and anchors opening in a new tab', () => {
    const div = document.createElement('div');
    div.replaceChildren(...linkifyNodes('<i>x</i> https://a.example/p'));
    assert.strictEqual(div.childNodes.length, 2);
    assert.strictEqual(div.childNodes[0].nodeType, 3);
    assert.strictEqual(div.textContent, '<i>x</i> https://a.example/p');
    const a = div.querySelector('a');
    assert.ok(a);
    assert.strictEqual(a.getAttribute('href'), 'https://a.example/p');
    assert.strictEqual(a.target, '_blank');
    assert.strictEqual(a.rel, 'noopener noreferrer');
    assert.strictEqual(div.querySelector('i'), null);
  });
});

describe('renderWithMentions', () => {
  it('renders links and mention chips, not taking an @ in a URL as a mention', () => {
    const div = document.createElement('div');
    renderWithMentions(div, '@jdoe see https://social.example/@jdoe', new Map([['jdoe', 'Jane Doe']]));
    const chips = div.querySelectorAll('.mention-chip');
    assert.strictEqual(chips.length, 1);
    assert.strictEqual(chips[0].textContent, 'Jane Doe');
    const a = div.querySelector('a');
    assert.ok(a);
    assert.strictEqual(a.textContent, 'https://social.example/@jdoe');
  });
});

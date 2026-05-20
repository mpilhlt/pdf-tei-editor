/**
 * Unit tests for tei-annotator frontend extension helpers.
 *
 * @testCovers fastapi_app/plugins/tei_annotator/extensions/tei-annotator.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM();
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Document = dom.window.Document;
global.DOMParser = dom.window.DOMParser;
// Stub browser-only base class — must be set before the dynamic import below
global.FrontendExtensionPlugin = class {};

// Dynamic import so globals above are in place before module evaluation
const { getIndentation, adjustFragmentIndentation } = await import('../extensions/tei-annotator.js');

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/**
 * Parse an XML string and return the first <bibl> element.
 * @param {string} xml
 * @returns {Element}
 */
function parseBibl(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return doc.getElementsByTagNameNS(TEI_NS, 'bibl')[0];
}

describe('getIndentation', () => {
  it('returns the whitespace after the last \\n in the preceding text node', () => {
    const bibl = parseBibl(
      `<listBibl xmlns="${TEI_NS}">\n    <bibl>x</bibl>\n</listBibl>`
    );
    assert.strictEqual(getIndentation(bibl), '    ');
  });

  it('returns empty string when there is no preceding sibling', () => {
    const bibl = parseBibl(`<listBibl xmlns="${TEI_NS}"><bibl>x</bibl></listBibl>`);
    assert.strictEqual(getIndentation(bibl), '');
  });

  it('returns empty string when the preceding text node has no \\n', () => {
    const bibl = parseBibl(`<listBibl xmlns="${TEI_NS}">  <bibl>x</bibl></listBibl>`);
    assert.strictEqual(getIndentation(bibl), '');
  });

  it('handles tab indentation', () => {
    const bibl = parseBibl(`<listBibl xmlns="${TEI_NS}">\n\t<bibl>x</bibl>\n</listBibl>`);
    assert.strictEqual(getIndentation(bibl), '\t');
  });
});

describe('adjustFragmentIndentation', () => {
  it('returns the fragment unchanged when indent is empty', () => {
    const frag = '<bibl>a</bibl>\n<bibl>b</bibl>';
    assert.strictEqual(adjustFragmentIndentation(frag, ''), frag);
  });

  it('returns the fragment unchanged when there are no newlines', () => {
    const frag = '<bibl>a</bibl>';
    assert.strictEqual(adjustFragmentIndentation(frag, '  '), frag);
  });

  it('replaces a \\n in the middle with \\n + indent', () => {
    const frag = '<bibl>a</bibl>\n<bibl>b</bibl>';
    assert.strictEqual(
      adjustFragmentIndentation(frag, '    '),
      '<bibl>a</bibl>\n    <bibl>b</bibl>'
    );
  });

  it('strips a leading \\n and replaces subsequent ones', () => {
    const frag = '\n<bibl>a</bibl>\n<bibl>b</bibl>';
    assert.strictEqual(
      adjustFragmentIndentation(frag, '  '),
      '<bibl>a</bibl>\n  <bibl>b</bibl>'
    );
  });

  it('replaces multiple inner newlines', () => {
    const frag = '<bibl>a</bibl>\n<bibl>b</bibl>\n<bibl>c</bibl>';
    assert.strictEqual(
      adjustFragmentIndentation(frag, '  '),
      '<bibl>a</bibl>\n  <bibl>b</bibl>\n  <bibl>c</bibl>'
    );
  });

  it('strips a sole leading \\n', () => {
    const frag = '\n';
    assert.strictEqual(adjustFragmentIndentation(frag, '  '), '');
  });
});

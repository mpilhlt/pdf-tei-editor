#!/usr/bin/env node

/**
 * Unit tests for the XML utilities.
 * @testCovers app/src/modules/xml-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM();
global.Node = dom.window.Node;
global.Document = dom.window.Document;

const { prettyPrintXmlDom, hasMixedContent } = await import('../../../app/src/modules/xml-utils.js');

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/** @param {string} source */
const parse = source => new dom.window.DOMParser().parseFromString(source, 'application/xml');
/** @param {Document} doc */
const serialize = doc => new dom.window.XMLSerializer().serializeToString(doc);

describe('prettyPrintXmlDom', () => {
  it('indents the teiHeader', () => {
    const doc = parse(`<TEI xmlns="${TEI_NS}"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader></TEI>`);
    prettyPrintXmlDom(doc, 'teiHeader');
    assert.match(serialize(doc), /<teiHeader>\n\s+<fileDesc>\n\s+<titleStmt>\n\s+<title>T<\/title>/);
  });

  it('keeps the content of desc elements', () => {
    const doc = parse(`<TEI xmlns="${TEI_NS}"><teiHeader><revisionDesc><change><desc><ptr target="x"/> <measure quantity="2"/></desc></change></revisionDesc></teiHeader></TEI>`);
    prettyPrintXmlDom(doc, 'teiHeader');
    const out = serialize(doc);
    assert.ok(out.includes('<desc><ptr target="x"/> <measure quantity="2"/></desc>'), out);
    assert.match(out, /<change>\n\s+<desc>/);
  });

  it('keeps the content of header elements with mixed content', () => {
    const doc = parse(`<TEI xmlns="${TEI_NS}"><teiHeader><fileDesc><publicationStmt><availability><licence>See <ref target="a">A</ref> <ref target="b">B</ref>.</licence></availability></publicationStmt></fileDesc></teiHeader></TEI>`);
    prettyPrintXmlDom(doc, 'teiHeader');
    assert.ok(serialize(doc).includes('<licence>See <ref target="a">A</ref> <ref target="b">B</ref>.</licence>'));
  });

  it('applies the header rules only in the teiHeader', () => {
    const doc = parse(`<TEI xmlns="${TEI_NS}"><teiHeader/><text><desc><p>a</p></desc></text></TEI>`);
    prettyPrintXmlDom(doc);
    assert.match(serialize(doc), /<desc>\n\s+<p>a<\/p>/);
  });
});

describe('hasMixedContent', () => {
  it('needs both child elements and text other than XML whitespace', () => {
    const doc = parse('<r><a>t<b/></a><c> <b/> </c><d>text</d><e> <b/></e></r>');
    const [a, c, d, e] = Array.from(doc.documentElement.children);
    assert.deepStrictEqual([a, c, d, e].map(el => hasMixedContent(/** @type {Element} */ (el))), [true, false, false, true]);
  });
});

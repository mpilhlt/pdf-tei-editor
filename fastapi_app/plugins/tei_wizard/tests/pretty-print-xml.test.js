/**
 * Unit tests for pretty-print-xml enhancement
 *
 * @testCovers fastapi_app/plugins/tei_wizard/enhancements/pretty-print-xml.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM();
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Document = dom.window.Document;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;

import { execute } from '../enhancements/pretty-print-xml.js';

const TEI_NS = "http://www.tei-c.org/ns/1.0";

function parse(xml) {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function serialize(xmlDoc) {
  return new XMLSerializer().serializeToString(xmlDoc);
}

/**
 * Run execute() and return the serialized output for inspection.
 * @param {string} xml
 * @returns {string}
 */
function prettyPrint(xml) {
  const doc = parse(xml);
  execute(doc, {}, new Map());
  return serialize(doc);
}

/**
 * Run execute() with an environment whose findUnits() returns the elements matched by `selector`.
 * @param {string} xml
 * @param {string} localName - Local name of the unit elements below <text>
 * @returns {string}
 */
function prettyPrintWithUnits(xml, localName) {
  const doc = parse(xml);
  const env = {
    variant: 'test',
    unitPath: `.//${localName}`,
    findUnits: (/** @type {Document} */ d) => Array.from(d.getElementsByTagNameNS(TEI_NS, 'text')[0].getElementsByTagNameNS(TEI_NS, localName))
  };
  execute(doc, {}, new Map(), env);
  return serialize(doc);
}

describe('pretty-print-xml enhancement', () => {

  describe('listBibl with bibl children', () => {
    it('indents bibl children inside listBibl', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><listBibl><bibl>Entry one</bibl><bibl>Entry two</bibl></listBibl></text></TEI>`;
      const out = prettyPrint(input);
      console.log('--- listBibl with bibl children ---\n' + out);
      assert.ok(out.includes('\n  <bibl>Entry one</bibl>') || out.match(/\n\s+<bibl>/), 'bibl elements should be on separate indented lines');
    });

    it('does NOT indent inside bibl (text flow preserved)', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><listBibl><bibl><label>2</label> Some text <lb/> more text</bibl></listBibl></text></TEI>`;
      const out = prettyPrint(input);
      console.log('--- bibl content not indented ---\n' + out);
      // The label and lb inside bibl must NOT be on their own indented lines
      assert.ok(!out.match(/<bibl>[^<]*\n\s+<label>/), 'label inside bibl should not be on an indented new line');
    });
  });

  describe('listBibl with raw text (training segmentation documents)', () => {
    it('does NOT indent when listBibl contains only text', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><listBibl>Smith, J. Title 2020. Jones, A. Another title.</listBibl></text></TEI>`;
      const out = prettyPrint(input);
      console.log('--- listBibl raw text ---\n' + out);
      assert.ok(out.includes('Smith, J. Title 2020.'), 'text content must be preserved');
      assert.ok(!out.match(/<listBibl>\s*\n\s+Smith/), 'raw text in listBibl should not be indented');
    });

    it('does NOT indent when listBibl contains text and lb elements', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><listBibl>Smith text<lb/> more text<lb/> end.</listBibl></text></TEI>`;
      const out = prettyPrint(input);
      console.log('--- listBibl text+lb ---\n' + out);
      assert.ok(!out.match(/<listBibl>\s*\n\s+<lb/), 'lb inside text-only listBibl should not get leading indent');
    });
  });

  describe('real-world: segmented listBibl with bibl entries', () => {
    it('indents bibl entries but not their inline content', () => {
      const input = `<TEI xmlns="${TEI_NS}">
        <text xml:lang="en">
        <listBibl>
        <bibl><label>2</label> Law-Related Education Act<lb/> more text </bibl>
        <bibl><label>4</label> Feinstein, S.<lb/> https://perma.cc/KCL2-8VFM<lb/> </bibl>
        <bibl><label>5</label> Id.<lb/> </bibl>
        </listBibl>
        </text>
        </TEI>`;
      const out = prettyPrint(input);
      console.log('--- real-world segmented listBibl ---\n' + out);

      // listBibl should have indented bibl children
      assert.ok(out.match(/\n\s+<bibl>/), 'bibl elements should be indented within listBibl');
      // bibl children (label, lb) must NOT be on separate indented lines
      assert.ok(!out.match(/<bibl>[^<]*\n\s+<label>/), 'label inside bibl must not be indented');
      assert.ok(!out.match(/<bibl>[^<]*\n\s+<lb/), 'lb inside bibl must not be indented');
    });
  });

  describe('real test.xml file (listBibl with bibl + stray text)', () => {
    it('indents bibl elements even when stray text nodes exist between them', { skip: !existsSync('.local/test.xml') && 'local test file .local/test.xml not present' }, () => {
      const xml = readFileSync('.local/test.xml', 'utf-8');
      const out = prettyPrint(xml);
      // Every bibl opening tag must be preceded by a newline+whitespace (i.e. on its own indented line)
      const biblMatches = out.match(/<bibl>/g) || [];
      const indentedBiblMatches = out.match(/\n\s+<bibl>/g) || [];
      console.log(`--- test.xml: ${biblMatches.length} <bibl> tags, ${indentedBiblMatches.length} indented ---`);
      console.log(out.slice(out.indexOf('<text'), out.indexOf('<text') + 600));
      assert.ok(indentedBiblMatches.length > 0, 'at least some bibl elements should be indented');
      assert.strictEqual(indentedBiblMatches.length, biblMatches.length,
        `all ${biblMatches.length} <bibl> elements should be on their own indented lines`);
    });
  });

  describe('structural elements', () => {
    it('indents teiHeader children', () => {
      const input = `<TEI xmlns="${TEI_NS}"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader></TEI>`;
      const out = prettyPrint(input);
      console.log('--- teiHeader structure ---\n' + out);
      assert.ok(out.match(/\n\s+<teiHeader/), 'teiHeader should be indented');
      assert.ok(out.match(/\n\s+<fileDesc/), 'fileDesc should be indented');
    });

    it('does not indent note that contains only text', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><div><note>Just a plain note.</note></div></text></TEI>`;
      const out = prettyPrint(input);
      console.log('--- note with text only ---\n' + out);
      assert.ok(out.includes('Just a plain note.'), 'note text must be preserved');
    });

    it('indents note that contains p children', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><div><note><p>First.</p><p>Second.</p></note></div></text></TEI>`;
      const out = prettyPrint(input);
      console.log('--- note with p children ---\n' + out);
      assert.ok(out.match(/\n\s+<p>/), 'p elements inside note should be indented');
    });
  });

  describe('inline elements between block elements', () => {
    it('puts a pb between block elements on its own line', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><body><div><p>One</p></div><pb n="2"/><div><p>Two</p></div></body></text></TEI>`;
      const out = prettyPrint(input);
      assert.ok(out.includes('</div>\n      <pb n="2"/>\n      <div>'), out);
    });

    it('puts a trailing pb on its own line before the closing tag', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><body><div><p>One</p></div><pb n="2"/></body></text></TEI>`;
      const out = prettyPrint(input);
      assert.ok(out.includes('</div>\n      <pb n="2"/>\n    </body>'), out);
    });

    it('puts a leading pb on its own line', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><body><pb n="1"/><div><p>One</p></div></body></text></TEI>`;
      const out = prettyPrint(input);
      assert.ok(out.includes('<body>\n      <pb n="1"/>\n      <div>'), out);
    });

    it('leaves a pb that follows text in place', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><body><div><p>One</p></div>stray<pb n="2"/>text<div><p>Two</p></div></body></text></TEI>`;
      const out = prettyPrint(input);
      assert.ok(out.includes('stray<pb n="2"/>text'), out);
    });

    it('leaves a pb inside a paragraph in place', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><body><p>One<pb n="2"/>two</p></body></text></TEI>`;
      const out = prettyPrint(input);
      assert.ok(out.includes('<p>One<pb n="2"/>two</p>'), out);
    });

    it('keeps consecutive inline elements together', () => {
      const input = `<TEI xmlns="${TEI_NS}"><text><body><div><p>One</p></div><pb n="2"/><cb n="1"/><div><p>Two</p></div></body></text></TEI>`;
      const out = prettyPrint(input);
      assert.ok(out.includes('</div>\n      <pb n="2"/><cb n="1"/>\n      <div>'), out);
    });
  });

  describe('review units', () => {
    const unitXml = `<TEI xmlns="${TEI_NS}"><text><back><listBibl><bibl><author>A</author> <title>T</title>  <lb/>x</bibl><bibl><label>2</label> <author>B</author></bibl></listBibl></back></text></TEI>`;

    it('keeps the content of each unit byte for byte', () => {
      const out = prettyPrintWithUnits(unitXml, 'bibl');
      assert.ok(out.includes('<bibl><author>A</author> <title>T</title>  <lb/>x</bibl>'), out);
      assert.ok(out.includes('<bibl><label>2</label> <author>B</author></bibl>'), out);
    });

    it('puts each unit on its own line and indents its ancestors', () => {
      const out = prettyPrintWithUnits(unitXml, 'bibl');
      assert.match(out, /\n {2}<text>\n {4}<back>\n {6}<listBibl>\n {8}<bibl>/);
      assert.strictEqual((out.match(/\n {8}<bibl>/g) || []).length, 2, out);
    });

    it('indents ancestors that the heuristic would leave alone', () => {
      const xml = `<TEI xmlns="${TEI_NS}"><text><p><seg>one</seg><seg>two</seg></p></text></TEI>`;
      const out = prettyPrintWithUnits(xml, 'seg');
      assert.match(out, /<p>\n\s+<seg>one<\/seg>\n\s+<seg>two<\/seg>\n\s+<\/p>/);
    });

    it('strips whitespace inside units without them (generic behavior)', () => {
      const out = prettyPrint(unitXml);
      assert.ok(out.includes('<author>A</author><title>T</title>'), out);
    });
  });

  describe('teiHeader', () => {
    it('keeps desc elements even without text', () => {
      const xml = `<TEI xmlns="${TEI_NS}"><teiHeader><revisionDesc><change><desc><ptr target="x"/> <measure quantity="2"/></desc></change></revisionDesc></teiHeader></TEI>`;
      const out = prettyPrint(xml);
      assert.ok(out.includes('<desc><ptr target="x"/> <measure quantity="2"/></desc>'), out);
      assert.match(out, /\n\s+<change>\n\s+<desc>/);
    });

    it('keeps elements with mixed content, including the space between inline elements', () => {
      const xml = `<TEI xmlns="${TEI_NS}"><teiHeader><fileDesc><publicationStmt><availability><licence>See <ref target="a">A</ref> <ref target="b">B</ref>.</licence></availability></publicationStmt></fileDesc></teiHeader></TEI>`;
      const out = prettyPrint(xml);
      assert.ok(out.includes('<licence>See <ref target="a">A</ref> <ref target="b">B</ref>.</licence>'), out);
      assert.match(out, /\n\s+<availability>\n\s+<licence>/);
    });

    it('indents header elements without mixed content as before', () => {
      const xml = `<TEI xmlns="${TEI_NS}"><teiHeader><fileDesc><titleStmt><title>T</title><author><persName>P</persName></author></titleStmt></fileDesc></teiHeader></TEI>`;
      const out = prettyPrint(xml);
      assert.match(out, /\n\s+<author>\n\s+<persName>P<\/persName>\n\s+<\/author>/);
    });

    it('applies the header rules only in the teiHeader', () => {
      const xml = `<TEI xmlns="${TEI_NS}"><text><div><desc><p>a</p></desc></div></text></TEI>`;
      const out = prettyPrint(xml);
      assert.match(out, /<desc>\n\s+<p>a<\/p>/);
    });

    it('reads the kept header elements from the config', () => {
      const xml = `<TEI xmlns="${TEI_NS}"><teiHeader><encodingDesc><appInfo><application><label>x</label></application></appInfo></encodingDesc></teiHeader></TEI>`;
      const doc = parse(xml);
      execute(doc, {}, new Map([['tei.pretty-print.header-keep', ['appInfo']]]));
      assert.ok(serialize(doc).includes('<appInfo><application><label>x</label></application></appInfo>'));
    });
  });
});

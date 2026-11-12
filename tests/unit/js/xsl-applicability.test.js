#!/usr/bin/env node

/**
 * Unit tests for the applicability check of XSL stylesheets
 * @testCovers app/src/modules/xsl-applicability.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.XPathResult = dom.window.XPathResult;

const { stylesheetAppliesTo } = await import('../../../app/src/modules/xsl-applicability.js');

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/**
 * @param {string} xml
 * @returns {Document}
 */
function parse(xml) {
  return new dom.window.DOMParser().parseFromString(xml, 'application/xml');
}

// jsdom's XPath engine does not resolve prefixes against a default-namespaced document (unlike
// real browsers), so the fixtures use an explicit `tei:` prefix
const withRefs = parse(`<tei:TEI xmlns:tei="${TEI_NS}"><tei:text><tei:body><tei:listBibl><tei:biblStruct/></tei:listBibl></tei:body></tei:text></tei:TEI>`);
const withoutRefs = parse(`<tei:TEI xmlns:tei="${TEI_NS}"><tei:teiHeader><tei:encodingDesc><tei:appInfo><tei:application type="extractor"><tei:label type="variant-id">archival-edition</tei:label></tei:application></tei:appInfo></tei:encodingDesc></tei:teiHeader><tei:text><tei:body><tei:pb/></tei:body></tei:text></tei:TEI>`);
const otherNs = parse('<root><biblStruct/></root>');

describe('stylesheetAppliesTo', () => {
  it('applies to every document in the namespace without a test', () => {
    const rule = { label: 'any', xmlns: TEI_NS };
    assert.strictEqual(stylesheetAppliesTo(rule, withRefs), true);
    assert.strictEqual(stylesheetAppliesTo(rule, withoutRefs), true);
  });

  it('never applies to a document in another namespace or to no document', () => {
    const rule = { label: 'any', xmlns: TEI_NS };
    assert.strictEqual(stylesheetAppliesTo(rule, otherNs), false);
    assert.strictEqual(stylesheetAppliesTo(rule, null), false);
  });

  it('evaluates a boolean XPath test with the tei prefix', () => {
    const rule = { label: 'refs', xmlns: TEI_NS, appliesTo: 'boolean(//tei:biblStruct)' };
    assert.strictEqual(stylesheetAppliesTo(rule, withRefs), true);
    assert.strictEqual(stylesheetAppliesTo(rule, withoutRefs), false);
  });

  it('converts node-set, string and number results to booleans', () => {
    const nodes = { label: 'n', xmlns: TEI_NS, appliesTo: '//tei:biblStruct' };
    const string = { label: 's', xmlns: TEI_NS, appliesTo: 'string(//tei:label[@type="variant-id"])' };
    const number = { label: 'c', xmlns: TEI_NS, appliesTo: 'count(//tei:pb)' };
    assert.strictEqual(stylesheetAppliesTo(nodes, withRefs), true);
    assert.strictEqual(stylesheetAppliesTo(nodes, withoutRefs), false);
    assert.strictEqual(stylesheetAppliesTo(string, withoutRefs), true);
    assert.strictEqual(stylesheetAppliesTo(string, withRefs), false);
    assert.strictEqual(stylesheetAppliesTo(number, withoutRefs), true);
    assert.strictEqual(stylesheetAppliesTo(number, withRefs), false);
  });

  it('compares the variant in XPath', () => {
    const rule = { label: 'v', xmlns: TEI_NS, appliesTo: '//tei:label[@type="variant-id"] = "archival-edition"' };
    assert.strictEqual(stylesheetAppliesTo(rule, withoutRefs), true);
    assert.strictEqual(stylesheetAppliesTo(rule, withRefs), false);
  });

  it('calls a function test with the document', () => {
    const rule = { label: 'f', xmlns: TEI_NS, appliesTo: (/** @type {Document} */ doc) => doc === withRefs };
    assert.strictEqual(stylesheetAppliesTo(rule, withRefs), true);
    assert.strictEqual(stylesheetAppliesTo(rule, withoutRefs), false);
  });

  it('treats a failing test as not applicable', () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const badXpath = { label: 'x', xmlns: TEI_NS, appliesTo: '//tei:[' };
      const throwing = { label: 't', xmlns: TEI_NS, appliesTo: () => { throw new Error('boom'); } };
      assert.strictEqual(stylesheetAppliesTo(badXpath, withRefs), false);
      assert.strictEqual(stylesheetAppliesTo(throwing, withRefs), false);
    } finally {
      console.warn = originalWarn;
    }
  });
});

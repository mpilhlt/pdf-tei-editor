/**
 * Unit tests for split-bibl enhancement
 *
 * Tests the bibl element splitting on semicolons.
 *
 * @testCovers fastapi_app/plugins/grobid/enhancements/split-bibl.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Setup JSDOM environment
const dom = new JSDOM();
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Document = dom.window.Document;
global.DOMParser = dom.window.DOMParser;

// Import the module under test
import { execute, splitBiblElement, name, description } from '../enhancements/split-bibl.js';

const TEI_NS = "http://www.tei-c.org/ns/1.0";

/**
 * Creates a TEI XML document with a listBibl containing bibl elements.
 * @param {string} biblContent - The inner content of the bibl element
 * @returns {Document} - The parsed XML document
 */
function createTeiDocument(biblContent) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="${TEI_NS}">
  <text>
    <body>
      <listBibl>
        <bibl>${biblContent}</bibl>
      </listBibl>
    </body>
  </text>
</TEI>`;
  return new DOMParser().parseFromString(xml, "application/xml");
}

/**
 * Gets all bibl elements from a TEI document's listBibl.
 * @param {Document} xmlDoc - The XML document
 * @returns {Element[]} - Array of bibl elements
 */
function getBiblElements(xmlDoc) {
  const listBibl = xmlDoc.getElementsByTagNameNS(TEI_NS, "listBibl")[0];
  return Array.from(listBibl.getElementsByTagNameNS(TEI_NS, "bibl"))
    .filter(bibl => bibl.parentNode === listBibl);
}

/**
 * Gets the first bibl element from a TEI document.
 * @param {Document} xmlDoc - The XML document
 * @returns {Element} - The first bibl element
 */
function getFirstBibl(xmlDoc) {
  return xmlDoc.getElementsByTagNameNS(TEI_NS, "bibl")[0];
}

/**
 * Gets the listBibl element from a TEI document.
 * @param {Document} xmlDoc - The XML document
 * @returns {Element} - The listBibl element
 */
function getListBibl(xmlDoc) {
  return xmlDoc.getElementsByTagNameNS(TEI_NS, "listBibl")[0];
}

describe('split-bibl enhancement', () => {
  describe('metadata', () => {
    it('should export name', () => {
      assert.strictEqual(name, "Split <bibl> on semicolon");
    });

    it('should export description', () => {
      assert.strictEqual(description, "Split the selected bibl element on the semicolon character.");
    });
  });

  describe('basic splitting', () => {
    it('should split on semicolon', () => {
      const xmlDoc = createTeiDocument("First reference; Second reference");
      const bibl = getFirstBibl(xmlDoc);
      
      const result = splitBiblElement(bibl, xmlDoc);
      
      assert.strictEqual(result, true);
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 2, "Should create 2 bibl elements");
      assert.strictEqual(bibls[0].textContent, "First reference; ");
      assert.strictEqual(bibls[1].textContent, "Second reference");
    });

    it('should keep semicolon with first segment', () => {
      const xmlDoc = createTeiDocument("One; Two");
      const bibl = getFirstBibl(xmlDoc);
      
      splitBiblElement(bibl, xmlDoc);
      
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls[0].textContent, "One; ");
      assert.strictEqual(bibls[1].textContent, "Two");
    });

    it('should handle semicolon with trailing space', () => {
      const xmlDoc = createTeiDocument("One; Two; Three");
      const bibl = getFirstBibl(xmlDoc);
      
      splitBiblElement(bibl, xmlDoc);
      
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 3, "Should create 3 bibl elements");
      assert.strictEqual(bibls[0].textContent, "One; ");
      assert.strictEqual(bibls[1].textContent, "Two; ");
      assert.strictEqual(bibls[2].textContent, "Three");
    });

    it('should handle semicolon without trailing space', () => {
      const xmlDoc = createTeiDocument("One;Two");
      const bibl = getFirstBibl(xmlDoc);
      
      splitBiblElement(bibl, xmlDoc);
      
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 2);
      assert.strictEqual(bibls[0].textContent, "One;");
      assert.strictEqual(bibls[1].textContent, "Two");
    });
  });

  describe('mixed content', () => {
    it('should preserve child elements', () => {
      const xmlDoc = createTeiDocument('Text <lb/> more text; other text');
      const bibl = getFirstBibl(xmlDoc);
      
      splitBiblElement(bibl, xmlDoc);
      
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 2);
      
      // First bibl should have lb element
      const lb1 = bibls[0].getElementsByTagNameNS(TEI_NS, "lb");
      assert.strictEqual(lb1.length, 1, "First bibl should have lb element");
      
      // Second bibl should not have lb element
      const lb2 = bibls[1].getElementsByTagNameNS(TEI_NS, "lb");
      assert.strictEqual(lb2.length, 0, "Second bibl should not have lb element");
    });

    it('should split mixed content correctly', () => {
      const xmlDoc = createTeiDocument('This is <lb/> content; other <lb/> content');
      const bibl = getFirstBibl(xmlDoc);
      
      splitBiblElement(bibl, xmlDoc);
      
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 2);
      
      // First bibl: "This is <lb/> content; "
      assert.strictEqual(bibls[0].getElementsByTagNameNS(TEI_NS, "lb").length, 1);
      assert.ok(bibls[0].textContent.includes("This is"));
      
      // Second bibl: "other <lb/> content"
      assert.strictEqual(bibls[1].getElementsByTagNameNS(TEI_NS, "lb").length, 1);
      assert.ok(bibls[1].textContent.includes("other"));
    });

    it('should handle multiple elements in sequence', () => {
      const xmlDoc = createTeiDocument('<persName>Author</persName>, <title>Title</title>; <persName>Author2</persName>');
      const bibl = getFirstBibl(xmlDoc);
      
      splitBiblElement(bibl, xmlDoc);
      
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 2);
      
      // First bibl should have persName and title
      assert.strictEqual(bibls[0].getElementsByTagNameNS(TEI_NS, "persName").length, 1);
      assert.strictEqual(bibls[0].getElementsByTagNameNS(TEI_NS, "title").length, 1);
      
      // Second bibl should have persName
      assert.strictEqual(bibls[1].getElementsByTagNameNS(TEI_NS, "persName").length, 1);
    });
  });

  describe('edge cases', () => {
    it('should return unchanged when no semicolons', () => {
      const xmlDoc = createTeiDocument("No semicolons here");
      const bibl = getFirstBibl(xmlDoc);
      
      const result = splitBiblElement(bibl, xmlDoc);
      
      assert.strictEqual(result, false);
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 1);
      assert.strictEqual(bibls[0].textContent, "No semicolons here");
    });

    it('should return false when element is not a bibl', () => {
      const xmlDoc = createTeiDocument("Text; more text");
      const listBibl = getListBibl(xmlDoc);
      
      const result = splitBiblElement(listBibl, xmlDoc);
      
      assert.strictEqual(result, false);
      const bibls = getBiblElements(xmlDoc);
      assert.strictEqual(bibls.length, 1, "Should not split when target is not bibl");
    });
  });

  describe('error handling', () => {
    it('should throw error when xmlDoc is not a Document', () => {
      assert.throws(
        () => execute("not a document", { xpath: "//tei:bibl" }, new Map()),
        /Invalid parameter: Expected document/
      );
    });
  });
});
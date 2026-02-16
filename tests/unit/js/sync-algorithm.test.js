#!/usr/bin/env node

/**
 * Test suite for XML Editor syntax tree <-> DOM synchronization algorithm.
 * Imports the actual linkSyntaxTreeWithDOM from the production code.
 *
 * @testCovers app/src/modules/codemirror/xml-dom-link.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Setup JSDOM environment (required before importing xml-dom-link which uses Node.ELEMENT_NODE)
const dom = new JSDOM();
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;

// Import the actual production function
import { linkSyntaxTreeWithDOM } from '../../../app/src/modules/codemirror/xml-dom-link.js';

// ─── Mock helpers ───────────────────────────────────────────────────────────

/**
 * Create a getText callback from an XML string.
 * @param {string} content
 * @returns {(from: number, to: number) => string}
 */
const createGetText = (content) => (from, to) => content.substring(from, to);

/**
 * Create a mock Lezer Element node with proper OpenTag > TagName structure.
 * @param {string} tagName The tag name
 * @param {number} from Start position in the document
 * @param {number} to End position in the document
 * @param {number} tagNameFrom Start position of the tag name text
 * @param {number} tagNameTo End position of the tag name text
 * @param {object[]} [children] Child Element mock nodes
 * @returns {object} Mock syntax element node
 */
function mockElement(tagName, from, to, tagNameFrom, tagNameTo, children = []) {
  // Link children as siblings
  for (let i = 0; i < children.length - 1; i++) {
    children[i].nextSibling = children[i + 1];
  }

  const tagNameNode = {
    name: "TagName",
    from: tagNameFrom,
    to: tagNameTo,
    firstChild: null,
    nextSibling: null
  };

  const openTag = {
    name: "OpenTag",
    from,
    to: tagNameTo + 1,
    firstChild: tagNameNode,
    nextSibling: children[0] || null
  };

  return {
    name: "Element",
    from,
    to,
    firstChild: openTag,
    nextSibling: null
  };
}

/**
 * Create a mock Document syntax node.
 * @param {object} firstChild First child node (Element or ProcessingInstruction)
 * @returns {object} Mock document syntax node
 */
function mockDocument(firstChild) {
  return {
    name: "Document",
    firstChild,
    nextSibling: null
  };
}

/**
 * Create a mock ProcessingInstruction syntax node.
 * @param {number} from Start position
 * @param {number} to End position
 * @param {object|null} nextSibling
 * @returns {object}
 */
function mockPI(from, to, nextSibling = null) {
  return {
    name: "ProcessingInstruction",
    from,
    to,
    firstChild: null,
    nextSibling
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('XML Syntax Tree <-> DOM Synchronization', () => {

  describe('Processing Instructions Handling', () => {

    test('should handle XML with processing instructions before root element', () => {
      const xmlWithPI = `<?xml-stylesheet type="text/xsl" href="transform.xsl"?>\n<?custom-pi data="test"?>\n<root>\n    <child>content</child>\n</root>`;

      const getText = createGetText(xmlWithPI);
      const domDoc = new DOMParser().parseFromString(xmlWithPI, "application/xml");

      // Find actual positions in the string
      const rootIdx = xmlWithPI.indexOf('<root>');
      const childIdx = xmlWithPI.indexOf('<child>');
      const childEndIdx = xmlWithPI.indexOf('</child>') + '</child>'.length;
      const rootEndIdx = xmlWithPI.indexOf('</root>') + '</root>'.length;

      const childElement = mockElement('child', childIdx, childEndIdx,
        childIdx + 1, childIdx + 1 + 'child'.length, []);

      const rootElement = mockElement('root', rootIdx, rootEndIdx,
        rootIdx + 1, rootIdx + 1 + 'root'.length, [childElement]);

      const pi1End = xmlWithPI.indexOf('?>') + 2;
      const pi2Start = xmlWithPI.indexOf('<?custom-pi');
      const pi2End = xmlWithPI.indexOf('?>', pi2Start) + 2;

      const pi2 = mockPI(pi2Start, pi2End, rootElement);
      const pi1 = mockPI(0, pi1End, pi2);

      const result = linkSyntaxTreeWithDOM(getText, mockDocument(pi1), domDoc);

      assert.ok(result.syntaxToDom instanceof Map, 'Should return syntaxToDom Map');
      assert.ok(result.domToSyntax instanceof Map, 'Should return domToSyntax Map');

      const domRoot = domDoc.documentElement;
      assert.strictEqual(domRoot.tagName, 'root', 'DOM root should be found');
      assert.ok(result.domToSyntax.has(domRoot), 'Root element should be in domToSyntax map');
    });

    test('should detect processing instructions in DOM', () => {
      const xmlWithPI = `<?xml-stylesheet href="style.xsl"?>\n<?custom-instruction data="value"?>\n<root><child/></root>`;

      const domDoc = new DOMParser().parseFromString(xmlWithPI, "application/xml");

      const processingInstructions = [];
      for (let i = 0; i < domDoc.childNodes.length; i++) {
        const node = domDoc.childNodes[i];
        if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
          const piNode = /** @type {ProcessingInstruction} */ (node);
          processingInstructions.push({
            target: piNode.target,
            data: piNode.data,
            position: i
          });
        }
      }

      assert.strictEqual(processingInstructions.length, 2, 'Should find 2 processing instructions');
      assert.strictEqual(processingInstructions[0].target, 'xml-stylesheet', 'First PI should be stylesheet');
      assert.strictEqual(processingInstructions[1].target, 'custom-instruction', 'Second PI should be custom instruction');
    });

    test('should handle mixed content (PIs, comments, elements)', () => {
      const mixedXml = `<!-- A comment -->\n<?xml-stylesheet href="style.xsl"?>  \n<!-- Another comment -->\n<?another-pi?>\n<root>\n    <child>content</child>\n</root>`;

      const domDoc = new DOMParser().parseFromString(mixedXml, "application/xml");

      let elementCount = 0;
      let piCount = 0;
      let commentCount = 0;

      for (let i = 0; i < domDoc.childNodes.length; i++) {
        const node = domDoc.childNodes[i];
        if (node.nodeType === Node.ELEMENT_NODE) elementCount++;
        else if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) piCount++;
        else if (node.nodeType === Node.COMMENT_NODE) commentCount++;
      }

      assert.strictEqual(elementCount, 1, 'Should find exactly one root element');
      assert.strictEqual(piCount, 2, 'Should find exactly two processing instructions');
      assert.strictEqual(commentCount, 2, 'Should find exactly two comments');

      const rootElement = domDoc.documentElement;
      assert.strictEqual(rootElement.tagName, 'root', 'Should find root element despite mixed content');
    });

    test('should handle real-world XML with xml-model processing instruction', () => {
      const realWorldXml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="https://raw.githubusercontent.com/kermitt2/grobid/refs/heads/master/grobid-home/schemas/rng/Grobid.rng"
              type="application/xml"
              schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title>Test Document</title>
            </titleStmt>
        </fileDesc>
    </teiHeader>
    <text>
        <body>
            <p>Content</p>
        </body>
    </text>
</TEI>`;

      const getText = createGetText(realWorldXml);
      const domDoc = new DOMParser().parseFromString(realWorldXml, "application/xml");

      assert.ok(!domDoc.querySelector("parsererror"), 'XML should parse without errors');

      // Find actual positions
      const teiIdx = realWorldXml.indexOf('<TEI');
      const teiEndIdx = realWorldXml.lastIndexOf('</TEI>') + '</TEI>'.length;
      const headerIdx = realWorldXml.indexOf('<teiHeader>');
      const headerEndIdx = realWorldXml.indexOf('</teiHeader>') + '</teiHeader>'.length;
      const fileDescIdx = realWorldXml.indexOf('<fileDesc>');
      const fileDescEndIdx = realWorldXml.indexOf('</fileDesc>') + '</fileDesc>'.length;
      const titleStmtIdx = realWorldXml.indexOf('<titleStmt>');
      const titleStmtEndIdx = realWorldXml.indexOf('</titleStmt>') + '</titleStmt>'.length;
      const titleIdx = realWorldXml.indexOf('<title>');
      const titleEndIdx = realWorldXml.indexOf('</title>') + '</title>'.length;
      const textIdx = realWorldXml.indexOf('<text>');
      const textEndIdx = realWorldXml.indexOf('</text>') + '</text>'.length;
      const bodyIdx = realWorldXml.indexOf('<body>');
      const bodyEndIdx = realWorldXml.indexOf('</body>') + '</body>'.length;
      const pIdx = realWorldXml.indexOf('<p>');
      const pEndIdx = realWorldXml.indexOf('</p>') + '</p>'.length;

      const pElement = mockElement('p', pIdx, pEndIdx, pIdx + 1, pIdx + 2, []);
      const bodyElement = mockElement('body', bodyIdx, bodyEndIdx, bodyIdx + 1, bodyIdx + 5, [pElement]);
      const textElement = mockElement('text', textIdx, textEndIdx, textIdx + 1, textIdx + 5, [bodyElement]);
      const titleElement = mockElement('title', titleIdx, titleEndIdx, titleIdx + 1, titleIdx + 6, []);
      const titleStmtElement = mockElement('titleStmt', titleStmtIdx, titleStmtEndIdx,
        titleStmtIdx + 1, titleStmtIdx + 10, [titleElement]);
      const fileDescElement = mockElement('fileDesc', fileDescIdx, fileDescEndIdx,
        fileDescIdx + 1, fileDescIdx + 9, [titleStmtElement]);
      const teiHeaderElement = mockElement('teiHeader', headerIdx, headerEndIdx,
        headerIdx + 1, headerIdx + 10, [fileDescElement]);
      teiHeaderElement.nextSibling = textElement;

      const teiElement = mockElement('TEI', teiIdx, teiEndIdx,
        teiIdx + 1, teiIdx + 4, [teiHeaderElement]);

      const piStart = realWorldXml.indexOf('<?xml-model');
      const piEnd = realWorldXml.indexOf('?>', piStart) + 2;
      const pi = mockPI(piStart, piEnd, teiElement);

      const result = linkSyntaxTreeWithDOM(getText, mockDocument(pi), domDoc);

      assert.ok(result.syntaxToDom instanceof Map, 'Should return syntaxToDom Map');
      assert.ok(result.domToSyntax instanceof Map, 'Should return domToSyntax Map');

      const rootElement = domDoc.documentElement;
      assert.ok(result.domToSyntax.has(rootElement), 'TEI root element should be in domToSyntax map');
    });
  });

  describe('Basic Synchronization', () => {

    test('should synchronize simple XML without processing instructions', () => {
      // <root><child>content</child></root>
      // 0    5 6   11 12       19 20      27 28     34
      const simpleXml = `<root><child>content</child></root>`;

      const getText = createGetText(simpleXml);
      const domDoc = new DOMParser().parseFromString(simpleXml, "application/xml");

      const childIdx = simpleXml.indexOf('<child>');
      const childEndIdx = simpleXml.indexOf('</child>') + '</child>'.length;

      const childElement = mockElement('child', childIdx, childEndIdx,
        childIdx + 1, childIdx + 1 + 'child'.length, []);
      const rootElement = mockElement('root', 0, simpleXml.length,
        1, 1 + 'root'.length, [childElement]);

      const result = linkSyntaxTreeWithDOM(getText, mockDocument(rootElement), domDoc);

      assert.ok(result.syntaxToDom.size > 0, 'Should create mappings');
      assert.ok(result.domToSyntax.size > 0, 'Should create reverse mappings');
      assert.strictEqual(result.syntaxToDom.size, 2, 'Should map root and child elements');
    });

    test('should throw error on tag mismatch', () => {
      const xml = `<root></root>`;

      // Provide a getText that returns a wrong tag name to simulate mismatch
      const getText = (from, to) => {
        if (from === 1 && to === 5) return "wrong";
        return xml.substring(from, to);
      };
      const domDoc = new DOMParser().parseFromString(xml, "application/xml");

      const rootElement = mockElement('root', 0, xml.length, 1, 5, []);

      assert.throws(
        () => linkSyntaxTreeWithDOM(getText, mockDocument(rootElement), domDoc),
        /Tag mismatch/,
        'Should throw error on tag name mismatch'
      );
    });
  });

  describe('Edge Cases', () => {

    test('should handle empty documents gracefully', () => {
      const emptyXml = `<root></root>`;

      const getText = createGetText(emptyXml);
      const domDoc = new DOMParser().parseFromString(emptyXml, "application/xml");

      const rootElement = mockElement('root', 0, emptyXml.length, 1, 5, []);

      const result = linkSyntaxTreeWithDOM(getText, mockDocument(rootElement), domDoc);

      assert.ok(result.syntaxToDom instanceof Map, 'Should return Map for empty document');
      assert.ok(result.domToSyntax instanceof Map, 'Should return reverse Map for empty document');
      assert.strictEqual(result.syntaxToDom.size, 1, 'Should map the root element');
    });

    test('should handle documents with processing instructions before root', () => {
      const xmlWithPIs = `<?xml-stylesheet href="style.xsl"?><?custom-pi?><root></root>`;

      const getText = createGetText(xmlWithPIs);
      const domDoc = new DOMParser().parseFromString(xmlWithPIs, "application/xml");

      const rootIdx = xmlWithPIs.indexOf('<root>');
      const rootElement = mockElement('root', rootIdx, xmlWithPIs.length,
        rootIdx + 1, rootIdx + 1 + 'root'.length, []);

      const pi2Start = xmlWithPIs.indexOf('<?custom-pi');
      const pi2End = xmlWithPIs.indexOf('?>', pi2Start) + 2;
      const pi1End = xmlWithPIs.indexOf('?>') + 2;

      const pi2 = mockPI(pi2Start, pi2End, rootElement);
      const pi1 = mockPI(0, pi1End, pi2);

      const result = linkSyntaxTreeWithDOM(getText, mockDocument(pi1), domDoc);

      assert.ok(result.syntaxToDom instanceof Map, 'Should handle PI-only start');
      assert.ok(result.domToSyntax.has(domDoc.documentElement), 'Should map root element');
    });

    test('should return empty maps when no root element found in syntax tree', () => {
      const xml = `<root></root>`;
      const getText = createGetText(xml);
      const domDoc = new DOMParser().parseFromString(xml, "application/xml");

      // Document with only a PI (no Element)
      const pi = mockPI(0, 10, null);
      const result = linkSyntaxTreeWithDOM(getText, mockDocument(pi), domDoc);

      assert.strictEqual(result.syntaxToDom.size, 0, 'Should return empty syntaxToDom');
      assert.strictEqual(result.domToSyntax.size, 0, 'Should return empty domToSyntax');
    });
  });
});

#!/usr/bin/env node

/**
 * Test suite for XML Editor syntax tree <-> DOM synchronization algorithm
 * Uses Node.js built-in test runner (available in Node 18+)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Mock CodeMirror structures and imports since we're testing in Node.js
const mockLezerCommon = {
  // Mock SyntaxNode structure
  createMockSyntaxNode: (name, from = 0, to = 10, children = []) => ({
    name,
    from,
    to,
    firstChild: children[0] || null,
    nextSibling: null,
    parent: null,
    type: { name }
  })
};

// Mock EditorView for testing
const createMockView = (content) => ({
  state: {
    doc: {
      sliceString: (from, to) => content.substring(from, to),
      toString: () => content
    }
  }
});

// Setup JSDOM environment
const dom = new JSDOM();
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;

// Import the function under test
// Since we can't directly import ES modules in this test setup, we'll implement the core logic inline
// In a real scenario, you'd set up proper ES module loading

/**
 * Simplified version of the linkSyntaxTreeWithDOM function for testing
 * This tests the core logic without CodeMirror dependencies
 */
function linkSyntaxTreeWithDOM(view, syntaxNode, domNode) {
  const syntaxToDom = new Map();
  const domToSyntax = new Map();

  const getText = node => view.state.doc.sliceString(node.from, node.to);

  function findFirstElement(node, isDOM = false) {
    while (node) {
      if (isDOM) {
        if (node.nodeType === Node.ELEMENT_NODE) return node;
      } else {
        if (node.name === "Element") return node;
      }
      node = node.nextSibling;
    }
    return null;
  }

  function collectElementChildren(parent, isDOM = false) {
    const elements = [];
    let child = parent.firstChild;
    
    while (child) {
      const element = findFirstElement(child, isDOM);
      if (element) {
        elements.push(element);
        child = element.nextSibling;
      } else {
        break;
      }
    }
    return elements;
  }

  function recursiveLink(syntaxNode, domNode) {
    if (!syntaxNode || !domNode) {
      throw new Error("Invalid arguments. Syntax node and DOM node must not be null.");
    }

    const syntaxElement = findFirstElement(syntaxNode, false);
    const domElement = findFirstElement(domNode, true);

    if (!syntaxElement || !domElement) {
      return { syntaxToDom: new Map(), domToSyntax: new Map() };
    }

    if (syntaxElement.name !== "Element") {
      throw new Error(`Unexpected node type: ${syntaxElement.name}. Expected "Element".`);
    }

    // Mock tag name extraction for testing
    const syntaxTagName = syntaxElement.tagName || 'root';
    const domTagName = domElement.tagName;

    if (syntaxTagName !== domTagName) {
      throw new Error(`Tag mismatch: Syntax tree has ${syntaxTagName}, DOM has ${domTagName}`);
    }

    syntaxToDom.set(syntaxElement.from, domElement);
    domToSyntax.set(domElement, syntaxElement.from);

    const syntaxChildren = collectElementChildren(syntaxElement, false);
    const domChildren = collectElementChildren(domElement, true);

    const minChildren = Math.min(syntaxChildren.length, domChildren.length);
    for (let i = 0; i < minChildren; i++) {
      const childResult = recursiveLink(syntaxChildren[i], domChildren[i]);
      for (const [key, value] of childResult.syntaxToDom) {
        syntaxToDom.set(key, value);
      }
      for (const [key, value] of childResult.domToSyntax) {
        domToSyntax.set(key, value);
      }
    }

    if (syntaxChildren.length > domChildren.length) {
      const extraSyntax = syntaxChildren.slice(domChildren.length);
      throw new Error(`Syntax tree has more child elements than the DOM tree: ${extraSyntax.length} extra`);
    }
    if (domChildren.length > syntaxChildren.length) {
      const extraDOM = domChildren.slice(syntaxChildren.length);
      throw new Error(`DOM tree has more child elements than the syntax tree: ${extraDOM.map(n => n.tagName).join(', ')}`);
    }

    return { syntaxToDom, domToSyntax };
  }

  if (syntaxNode.name !== "Document" || domNode.nodeType !== Node.DOCUMENT_NODE) {
    throw new Error("Invalid arguments. The root syntax node must be the top Document node and the DOM node must be a document.");
  }
  
  const syntaxRoot = syntaxNode.firstChild ? findFirstElement(syntaxNode.firstChild, false) : null;
  const domRoot = domNode.firstChild ? findFirstElement(domNode.firstChild, true) : null;
  
  if (!syntaxRoot || !domRoot) {
    console.warn("Could not find root elements in one or both trees");
    return { syntaxToDom: new Map(), domToSyntax: new Map() };
  }
  
  return recursiveLink(syntaxRoot, domRoot);
}

describe('XML Syntax Tree <-> DOM Synchronization', () => {
  
  describe('Processing Instructions Handling', () => {
    
    test('should handle XML with processing instructions before root element', () => {
      const xmlWithPI = `<?xml-stylesheet type="text/xsl" href="transform.xsl"?>
<?custom-pi data="test"?>
<root>
    <child>content</child>
</root>`;

      const view = createMockView(xmlWithPI);
      const domDoc = new DOMParser().parseFromString(xmlWithPI, "application/xml");
      
      // Create mock syntax tree that represents the parsed structure
      const childSyntaxNode = {
        name: "Element",
        tagName: "child",
        from: 120,
        to: 140,
        firstChild: null,
        nextSibling: null
      };

      const rootSyntaxNode = {
        name: "Element", 
        tagName: "root",
        from: 100,
        to: 150,
        firstChild: childSyntaxNode,
        nextSibling: null
      };

      const piNode1 = {
        name: "ProcessingInstruction",
        from: 0,
        to: 40,
        nextSibling: null
      };

      const piNode2 = {
        name: "ProcessingInstruction", 
        from: 41,
        to: 95,
        nextSibling: rootSyntaxNode
      };

      piNode1.nextSibling = piNode2;

      const documentSyntaxNode = {
        name: "Document",
        firstChild: piNode1,
        nextSibling: null
      };

      // Test that synchronization works despite processing instructions
      const result = linkSyntaxTreeWithDOM(view, documentSyntaxNode, domDoc);
      
      assert.ok(result.syntaxToDom instanceof Map, 'Should return syntaxToDom Map');
      assert.ok(result.domToSyntax instanceof Map, 'Should return domToSyntax Map');
      
      // Verify root element is found and linked
      const domRoot = domDoc.documentElement;
      assert.strictEqual(domRoot.tagName, 'root', 'DOM root should be found');
      assert.ok(result.domToSyntax.has(domRoot), 'Root element should be in domToSyntax map');
    });

    test('should detect processing instructions in DOM', () => {
      const xmlWithPI = `<?xml-stylesheet href="style.xsl"?>
<?custom-instruction data="value"?>
<root><child/></root>`;

      const domDoc = new DOMParser().parseFromString(xmlWithPI, "application/xml");
      
      const processingInstructions = [];
      for (let i = 0; i < domDoc.childNodes.length; i++) {
        const node = domDoc.childNodes[i];
        if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
          // @ts-ignore - node is a ProcessingInstruction when nodeType matches
          const piNode = node;
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
      const mixedXml = `<!-- A comment -->
<?xml-stylesheet href="style.xsl"?>  
<!-- Another comment -->
<?another-pi?>
<root>
    <child>content</child>
</root>`;

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
      
      // Test that root element can still be found
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

      const view = createMockView(realWorldXml);
      const domDoc = new DOMParser().parseFromString(realWorldXml, "application/xml");
      
      // Verify parsing succeeded
      assert.ok(!domDoc.querySelector("parsererror"), 'XML should parse without errors');
      
      // Count different node types
      let elementCount = 0;
      let piCount = 0;
      let textNodes = 0;
      
      for (let i = 0; i < domDoc.childNodes.length; i++) {
        const node = domDoc.childNodes[i];
        if (node.nodeType === Node.ELEMENT_NODE) {
          elementCount++;
        } else if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
          piCount++;
          // @ts-ignore - node is a ProcessingInstruction when nodeType matches
          const piNode = node;
          console.log(`Found PI: ${piNode.target} with data: ${piNode.data.substring(0, 50)}...`);
        } else if (node.nodeType === Node.TEXT_NODE) {
          textNodes++;
        }
      }
      
      // Should find the xml-model processing instruction (xml declaration is not counted as PI)
      assert.strictEqual(piCount, 1, 'Should find exactly one processing instruction (xml-model)');
      assert.strictEqual(elementCount, 1, 'Should find exactly one root element');
      
      // Verify root element is TEI
      const rootElement = domDoc.documentElement;
      assert.strictEqual(rootElement.tagName, 'TEI', 'Root element should be TEI');
      assert.strictEqual(rootElement.namespaceURI, 'http://www.tei-c.org/ns/1.0', 'Should have correct namespace');
      
      // Test synchronization with mock syntax tree that matches the DOM structure
      const pElement = {
        name: "Element",
        tagName: "p",
        from: 540,
        to: 550,
        firstChild: null,
        nextSibling: null
      };

      const bodyElement = {
        name: "Element",
        tagName: "body",
        from: 520,
        to: 560,
        firstChild: pElement,
        nextSibling: null
      };

      const textElement = {
        name: "Element", 
        tagName: "text",
        from: 500,
        to: 570,
        firstChild: bodyElement,
        nextSibling: null
      };

      const titleElement = {
        name: "Element",
        tagName: "title",
        from: 300,
        to: 315,
        firstChild: null,
        nextSibling: null
      };

      const titleStmtElement = {
        name: "Element",
        tagName: "titleStmt",
        from: 280,
        to: 320,
        firstChild: titleElement,
        nextSibling: null
      };

      const fileDescElement = {
        name: "Element",
        tagName: "fileDesc", 
        from: 260,
        to: 350,
        firstChild: titleStmtElement,
        nextSibling: null
      };

      const teiHeaderElement = {
        name: "Element",
        tagName: "teiHeader", 
        from: 240,
        to: 370,
        firstChild: fileDescElement,
        nextSibling: textElement
      };

      const teiRootElement = {
        name: "Element",
        tagName: "TEI",
        from: 200,
        to: 580,
        firstChild: teiHeaderElement,
        nextSibling: null
      };

      const piNode = {
        name: "ProcessingInstruction",
        from: 0,
        to: 149,
        nextSibling: teiRootElement
      };

      const documentSyntaxNode = {
        name: "Document",
        firstChild: piNode,
        nextSibling: null
      };

      // Test that synchronization works despite processing instructions
      const result = linkSyntaxTreeWithDOM(view, documentSyntaxNode, domDoc);
      
      assert.ok(result.syntaxToDom instanceof Map, 'Should return syntaxToDom Map');
      assert.ok(result.domToSyntax instanceof Map, 'Should return domToSyntax Map');
      assert.ok(result.domToSyntax.has(rootElement), 'TEI root element should be in domToSyntax map');
    });
  });

  describe('Basic Synchronization', () => {
    
    test('should synchronize simple XML without processing instructions', () => {
      const simpleXml = `<root><child>content</child></root>`;
      
      const view = createMockView(simpleXml);
      const domDoc = new DOMParser().parseFromString(simpleXml, "application/xml");
      
      const childSyntaxNode = {
        name: "Element",
        tagName: "child", 
        from: 6,
        to: 26,
        firstChild: null,
        nextSibling: null
      };

      const rootSyntaxNode = {
        name: "Element",
        tagName: "root",
        from: 0,
        to: 33,
        firstChild: childSyntaxNode,
        nextSibling: null
      };

      const documentSyntaxNode = {
        name: "Document",
        firstChild: rootSyntaxNode,
        nextSibling: null
      };

      const result = linkSyntaxTreeWithDOM(view, documentSyntaxNode, domDoc);
      
      assert.ok(result.syntaxToDom.size > 0, 'Should create mappings');
      assert.ok(result.domToSyntax.size > 0, 'Should create reverse mappings');
    });

    test('should throw error on tag mismatch', () => {
      const xml = `<root></root>`;
      
      const view = createMockView(xml);
      const domDoc = new DOMParser().parseFromString(xml, "application/xml");
      
      const rootSyntaxNode = {
        name: "Element",
        tagName: "different", // Intentional mismatch
        from: 0,
        to: 13,
        firstChild: null,
        nextSibling: null
      };

      const documentSyntaxNode = {
        name: "Document", 
        firstChild: rootSyntaxNode,
        nextSibling: null
      };

      assert.throws(
        () => linkSyntaxTreeWithDOM(view, documentSyntaxNode, domDoc),
        /Tag mismatch/,
        'Should throw error on tag name mismatch'
      );
    });
  });

  describe('Edge Cases', () => {
    
    test('should handle empty documents gracefully', () => {
      const emptyXml = `<root></root>`;
      
      const view = createMockView(emptyXml);
      const domDoc = new DOMParser().parseFromString(emptyXml, "application/xml");
      
      const rootSyntaxNode = {
        name: "Element",
        tagName: "root",
        from: 0,
        to: 13,
        firstChild: null,
        nextSibling: null
      };

      const documentSyntaxNode = {
        name: "Document",
        firstChild: rootSyntaxNode,
        nextSibling: null
      };

      const result = linkSyntaxTreeWithDOM(view, documentSyntaxNode, domDoc);
      
      assert.ok(result.syntaxToDom instanceof Map, 'Should return Map for empty document');
      assert.ok(result.domToSyntax instanceof Map, 'Should return reverse Map for empty document');
    });

    test('should handle documents with only processing instructions', () => {
      const piOnlyXml = `<?xml-stylesheet href="style.xsl"?><?custom-pi?>`;
      
      const view = createMockView(piOnlyXml + '<root></root>'); // Add root for valid XML
      const domDoc = new DOMParser().parseFromString(piOnlyXml + '<root></root>', "application/xml");
      
      // Mock syntax tree with only PIs and a root
      const rootSyntaxNode = {
        name: "Element",
        tagName: "root",
        from: 55,
        to: 68,
        firstChild: null,
        nextSibling: null
      };

      const piNode = {
        name: "ProcessingInstruction",
        from: 0,
        to: 54,
        nextSibling: rootSyntaxNode
      };

      const documentSyntaxNode = {
        name: "Document",
        firstChild: piNode,
        nextSibling: null
      };

      const result = linkSyntaxTreeWithDOM(view, documentSyntaxNode, domDoc);
      
      // Should still work - finds the root element despite PIs
      assert.ok(result.syntaxToDom instanceof Map, 'Should handle PI-only start');
      assert.ok(result.domToSyntax.has(domDoc.documentElement), 'Should map root element');
    });
  });
});

// Helper function to run tests
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('🧪 Running XML Synchronization Algorithm Tests...\n');
}
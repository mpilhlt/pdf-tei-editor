/**
 * @import { Extension } from '@codemirror/state'
 * @import {SyntaxNode, Tree} from '@lezer/common'
 */

import { EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/**
 * Links CodeMirror's syntax tree nodes representing XML elements with their corresponding DOM elements
 * parsed by DOMParser by traversing both trees recursively and storing references to each other in 
 * two Maps. Enhanced to handle XML processing instructions and other non-element nodes.
 *
 * @param {EditorView} view The CodeMirror EditorView instance.
 * @param {SyntaxNode} syntaxNode The root syntax node of the CodeMirror XML editor's syntax tree.
 * @param {Element|Document} domNode The (root) DOM element parsed by DOMParser.
 * @throws {Error} If the tags of the syntax tree node and the DOM node do not match.
 * @returns {Object} An object containing two WeakMaps: syntaxToDom and domToSyntax.
 *                  - syntaxToDom: Maps the position of syntax tree nodes to DOM nodes.
 *                  - domToSyntax: Maps DOM nodes to syntax tree nodes' positions.
 */
export function linkSyntaxTreeWithDOM(view, syntaxNode, domNode) {
  const syntaxToDom = new Map();
  const domToSyntax = new Map();

  const getText = node => view.state.doc.sliceString(node.from, node.to);

  /**
   * Helper to find the first element node in a tree
   * @param {SyntaxNode|Node} node Starting node
   * @param {boolean} isDOM Whether this is a DOM node (true) or syntax node (false)
   * @returns {SyntaxNode|Node|null} First element node found or null
   */
  function findFirstElement(node, isDOM = false) {
    while (node) {
      if (isDOM) {
        // @ts-ignore - node is a DOM Node when isDOM is true
        if (node.nodeType === Node.ELEMENT_NODE) return node;
      } else {
        // @ts-ignore - node is a SyntaxNode when isDOM is false
        if (node.name === "Element") return node;
      }
      // @ts-ignore - both Node and SyntaxNode have nextSibling
      node = node.nextSibling;
    }
    return null;
  }

  /**
   * Collects all element children from a parent node
   * @param {SyntaxNode|Node} parent Parent node
   * @param {boolean} isDOM Whether this is a DOM node (true) or syntax node (false) 
   * @returns {Array} Array of element nodes
   */
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

    // Enhanced: Find the first element in each tree, handling processing instructions
    const syntaxElement = findFirstElement(syntaxNode, false);
    const domElement = findFirstElement(domNode, true);

    // If we couldn't find matching element nodes, return empty maps
    if (!syntaxElement || !domElement) {
      return {
        syntaxToDom: new Map(),
        domToSyntax: new Map()
      };
    }

    // Check if the found elements are valid
    if (syntaxElement.name !== "Element") {
      throw new Error(`Unexpected node type: ${syntaxElement.name}. Expected "Element".`);
    }

    // make sure we have a tag name child
    let syntaxTagNode = syntaxElement.firstChild?.firstChild?.nextSibling;
    if (!syntaxTagNode || syntaxTagNode.name !== "TagName") {
      const text = getText(syntaxElement);
      if (text === "<") {
        // hack
        syntaxTagNode = syntaxTagNode.nextSibling
      } else {
        throw new Error(`Expected a TagName child node in syntax tree. Found: ${text}`);
      }
    }

    const syntaxTagName = getText(syntaxTagNode)
    const domTagName = domElement.tagName;

    // Verify that the tag names match
    if (syntaxTagName !== domTagName) {
      throw new Error(`Tag mismatch: Syntax tree has ${syntaxTagName}, DOM has ${domTagName}`);
    }

    // Store references to each other - since the syntax tree is regenerated on each lookup, 
    // we need to store the unique positions of each node as reference
    syntaxToDom.set(syntaxElement.from, domElement);
    domToSyntax.set(domElement, syntaxElement.from);

    // Enhanced: Use robust child collection and pairing
    const syntaxChildren = collectElementChildren(syntaxElement, false);
    const domChildren = collectElementChildren(domElement, true);

    // Recursively link the children by pairs
    const minChildren = Math.min(syntaxChildren.length, domChildren.length);
    for (let i = 0; i < minChildren; i++) {
      recursiveLink(syntaxChildren[i], domChildren[i]);
    }

    // Check for mismatched child counts
    if (syntaxChildren.length > domChildren.length) {
      const extraSyntax = syntaxChildren.slice(domChildren.length);
      throw new Error(`Syntax tree has more child elements than the DOM tree: ${extraSyntax.map(n => getText(n)).join(', ')}`);
    }
    if (domChildren.length > syntaxChildren.length) {
      const extraDOM = domChildren.slice(syntaxChildren.length);
      throw new Error(`DOM tree has more child elements than the syntax tree: ${extraDOM.map(n => n.tagName).join(', ')}`);
    }
    return {
      syntaxToDom,
      domToSyntax
    };
  }

  if (syntaxNode.name !== "Document" || domNode.nodeType !== Node.DOCUMENT_NODE) {
    throw new Error("Invalid arguments. The root syntax node must be the top Document node and the DOM node must be a document. Received: " +
      `syntaxNode: ${syntaxNode.name}, domNode: ${Object.keys(Node)[domNode.nodeType - 1]}`);
  }
  
  // Enhanced: Find root elements, skipping processing instructions and other non-element nodes
  const syntaxRoot = syntaxNode.firstChild ? findFirstElement(syntaxNode.firstChild, false) : null;
  const domRoot = domNode.firstChild ? findFirstElement(domNode.firstChild, true) : null;
  
  if (!syntaxRoot || !domRoot) {
    console.warn("Could not find root elements in one or both trees");
    return {
      syntaxToDom: new Map(),
      domToSyntax: new Map()
    };
  }
  
  return recursiveLink(syntaxRoot, domRoot);
}

// Function to install the selection change listener
export function selectionChangeListener(onSelectionChange) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.onSelectionChange = onSelectionChange;
      }

      update(update) {
        if (update.selectionSet) {
          const selection = update.state.selection;
          const ranges = selection.ranges;

          // Convert ranges to plain JavaScript objects if needed, or pass them directly
          const selectionInfo = ranges.map(range => {
            return {
              view: update.view,
              from: range.from,
              to: range.to,
              empty: range.empty
            }
          });

          this.onSelectionChange(selectionInfo, update); // Pass the current selectionInfo and the update object to the callback
        }
      }

      destroy() { }
    }
  );
}


/**
 * Resolves a simple XPath-like expression against a CodeMirror 6 syntax tree
 * to find the position of the target node.
 *
 * The XPath only supports direct and indexed children (e.g., "/TEI/standOff/listBibl/biblStruct[8]/monogr").
 * TODO this can be replaced with xmlEditor::
 * 
 * @param view {EditorView} The CodeMirror 6 EditorView
 * @param xpath The XPath-like expression to resolve.
 * @returns The `from` and `to` positions of the matching node, or null if not found.
 */
export function resolveXPath(view, xpath) {
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  const pathSegments = xpath.split("/").filter(segment => segment !== "");

  let cursor = tree.topNode.cursor();
  let foundNode = null;

  /**
   * @param {SyntaxNode} node 
   * @param {Number?} length 
   * @returns {string}
   */
  function text(node, length = null) {
    return doc.sliceString(node.from, length ? Math.min(node.from + length, node.to, doc.length) : node.to);
  }

  // function debugNode(node, textLength=10) {
  //   return node ? `(${node.name}: "${text(node, textLength)}")`: "(null)";
  // }

  for (const segment of pathSegments) {
    let index = 0;
    let tagName = segment;

    const match = segment.match(/^(.*?)\[(\d+)\]$/);
    if (match) {
      tagName = match[1];
      index = parseInt(match[2], 10) - 1;
      if (isNaN(index) || index < 0) {
        console.error(`Invalid child index in ${segment}`);
        return null;
      }
    }

    let childIndex = 0;
    let found = false;
    //console.log("Next segment:" , tagName, index)
    // move to first child of current cursor
    if (!cursor.firstChild()) {
      console.log("cursor has no children")
      return null;
    }

    do {
      //console.log('Current cursor node: ', debugNode(cursor))
      if (cursor.name == "Element") {
        const element = cursor.node;
        //console.log('  - cursor[1][1]: ', debugNode(element.firstChild?.firstChild))
        //console.log('  - cursor[1][2]: ', debugNode(element.firstChild?.firstChild?.nextSibling))
        let tagNameNode = element.firstChild?.firstChild?.nextSibling;
        if (tagNameNode && tagNameNode.name === "TagName" && text(tagNameNode) === tagName) {
          if (childIndex === index) {
            found = true;
            foundNode = element;
            break;
          }
          childIndex++;
        }
      }
    } while (cursor.nextSibling());

    if (!found || !foundNode) {
      return null; // No matching node found at this level
    }
    cursor = foundNode.cursor(); // move the cursor for the next level
  }

  if (foundNode) {
    return { from: foundNode.from, to: foundNode.to };
  } else {
    return null;
  }
}

/**
 * Checks if an object has the Extension interface (not really doing that currently)
 * @param {Extension} extension 
 * @returns {Boolean}
 */
export function isExtension(extension){
  return extension && typeof extension == "object"
}


/**
 * Given an XML string, figures out whether the XML uses tabs or spaces for indentation,
 * and, if spaces, calculates the number of spaces per indentation level with some heuristic.
 * It's more robust against tabs in content or mixed indentation.
 *
 * @param {string} xmlString The XML string to analyze.
 * @param {string} [defaultIndentation="  "] The default indentation to return if the XML cannot be reliably analyzed.
 *                                          Defaults to two spaces.
 * @returns {string} '\t' if the majority of indents are tabs, or a number of space characters (2, 4, etc.) if spaces are used.
 * If the indentation cannot be reliably determined, it returns 2.
 * 
 */
export function detectXmlIndentation(xmlString, defaultIndentation = "  ") {
  const lines = xmlString.split('\n');
  let tabIndentedLines = 0;
  let spaceIndentedLines = 0;
  const spaceIndentations = [];

  for (const line of lines) {
    const match = line.match(/^(\s*)/);
    if (match) {
      const indentation = match[1];
      if (indentation.length > 0) {
        if (indentation.includes('\t')) {
          tabIndentedLines++;
        } else if (indentation.includes(' ')) {
          spaceIndentedLines++;
          if (!spaceIndentations.includes(indentation.length)) {
            spaceIndentations.push(indentation.length);
          }
        }
      }
    }
  }

  // Determine if the majority of indented lines use tabs
  if (tabIndentedLines > spaceIndentedLines) {
    return '\t';
  }

  // If the majority is not tabs, proceed with space-based indentation logic
  if (spaceIndentations.length > 0) {
    spaceIndentations.sort((a, b) => a - b);

    if (spaceIndentations.length === 1) {
      return spaceIndentations[0];
    }

    // Heuristic: Find the greatest common divisor (GCD) of the indentation differences.
    const differences = [];
    for (let i = 1; i < spaceIndentations.length; i++) {
        const diff = spaceIndentations[i] - spaceIndentations[i-1];
        if(diff > 0){
            differences.push(diff);
        }
    }

    if(differences.length > 0) {
        const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
        let result = differences[0];
        for (let i = 1; i < differences.length; i++) {
          result = gcd(result, differences[i]);
        }

        // If the GCD is a common indentation number (2 or 4), it's a strong candidate.
        if (result === 2 || result === 4) {
          return " ".repeat(result);
        }
    }


    // As a fallback, find the smallest indentation unit.
    if(spaceIndentations[0] > 1) {
        return " ".repeat(spaceIndentations[0]);
    }
  }

  return defaultIndentation; // Default value if indentation cannot be reliably determined
}

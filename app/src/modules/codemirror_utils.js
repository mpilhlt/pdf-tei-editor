/**
 * @import { Extension } from '@codemirror/state'
 * @import {SyntaxNode, Tree} from '@lezer/common'
 */

import { EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/**
 * Links CodeMirror's syntax tree nodes representing XML elements with their corresponding DOM elements
 * parsed by DOMParser by traversing both trees recursively and storing references to each other in 
 * two Maps.
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

  function recursiveLink(syntaxNode, domNode) {

    if (!syntaxNode || !domNode) {
      throw new Error("Invalid arguments. Syntax node and DOM node must not be null.");
    }

    // Check if the syntaxNode and domNode are valid
    if (syntaxNode.name !== "Element" && syntaxNode.name !== "Document") {
      throw new Error(`Unexpected node type: ${syntaxNode.name}. Expected "Element" or "Document".`);
    }

    // make sure we have a tag name child
    let syntaxTagNode = syntaxNode.firstChild?.firstChild?.nextSibling;
    if (!syntaxTagNode || syntaxTagNode.name !== "TagName") {
      const text = getText(syntaxNode);
      if (text === "<") {
        // hack
        syntaxTagNode = syntaxTagNode.nextSibling
      } else {
        throw new Error(`Expected a TagName child node in syntax tree. Found: ${text}`);
      }
    }

    const syntaxTagName = getText(syntaxTagNode)
    const domTagName = domNode.tagName;

    // Verify that the tag names match
    if (syntaxTagName !== domTagName) {
      throw new Error(`Tag mismatch: Syntax tree has ${syntaxTagName}, DOM has ${domTagName}`);
    }

    // Store references to each other - since the syntax tree is regenerated on each lookup, 
    // we need to store the unique positions of each node as reference
    syntaxToDom.set(syntaxNode.from, domNode);
    domToSyntax.set(domNode, syntaxNode.from);

    // Recursively link the children. 
    let syntaxChild = syntaxNode.firstChild;
    let domChild = domNode.firstChild;

    while (syntaxChild && domChild) {
      // skip any non-element child in the syntax tree and the DOM tree 
      while (syntaxChild && syntaxChild.type.name !== "Element") {
        syntaxChild = syntaxChild.nextSibling;
      }
      while (domChild && domChild.nodeType !== Node.ELEMENT_NODE) {
        domChild = domChild.nextSibling;
      }

      // if we reach the end of one of the trees, stop
      if (!syntaxChild || !domChild) {
        break;
      }

      // recurse into the children, we are sure they are both of type element at this point
      recursiveLink(syntaxChild, domChild);
      domChild = domChild.nextSibling;
      syntaxChild = syntaxChild.nextSibling;
    }

    // we have reached the end of the branch we recursed into, either in the syntax tree or the DOM.
    if (syntaxChild && !domChild) {
      while (syntaxChild && syntaxChild.type.name !== "Element") {
        syntaxChild = syntaxChild.nextSibling;
      }
      if (syntaxChild) {
        throw new Error("Syntax tree has more child elements than the DOM tree:" + getText(syntaxChild));
      }
    }
    if (!syntaxChild && domChild && domChild.nodeType === Node.ELEMENT_NODE) {
      while (domChild && domChild.nodeType !== Node.ELEMENT_NODE) {
        domChild = domChild.nextSibling;
      }
      if (domChild) {
        throw new Error("DOM tree has more child elements than the syntax tree:", domChild.tagName);
      }
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
  return recursiveLink(syntaxNode.firstChild, domNode.firstChild);
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
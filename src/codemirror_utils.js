import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * Links CodeMirror's syntax tree nodes representing XML elements with their corresponding DOM elements
 * parsed by DOMParser by traversing both trees recursively and storing references to each other in 
 * two Maps.
 *
 * @param {EditorView} view The CodeMirror EditorView instance.
 * @param {SyntaxNode} syntaxNode The root syntax node of the CodeMirror XML editor's syntax tree.
 * @param {Element} domNode The root DOM element parsed by DOMParser.
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
    const syntaxTagNode = syntaxNode.firstChild?.firstChild?.nextSibling;
    if (!syntaxTagNode || syntaxTagNode.name !== "TagName") {
      throw new Error(`Expected a TagName child node in syntax tree. Found: ${getText(syntaxNode)}`);
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
        console.warn("Syntax tree has more child elements than the DOM tree:", getText(syntaxChild));
      }
    }
    if (!syntaxChild && domChild && domChild.nodeType === Node.ELEMENT_NODE) {
      while (domChild && domChild.nodeType !== Node.ELEMENT_NODE) {
        domChild = domChild.nextSibling;
      }
      if (domChild) {
        console.warn("DOM tree has more child elements than the syntax tree:", getText(domChild));
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
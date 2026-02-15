/**
 * @import {SyntaxNode} from '@lezer/common'
 * @import {ViewUpdate} from '@codemirror/view'
 */

/**
 * @typedef {Object.<string, any>} ReferenceMap
 * A recursive map structure that can contain references to other parts of itself.
 * Used for resolving deduplicated autocomplete data with "#x" and "#Mx" references.
 * Values can be strings, numbers, booleans, arrays, or other ReferenceMap objects.
 */

import { EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/**
 * Function to install the selection change listener
 * @param {function} onSelectionChange
 */
export function selectionChangeListener(onSelectionChange) {
  return ViewPlugin.fromClass(
    class {
      /**
       * @param {EditorView} _view
       */
      constructor(_view) {
        /** @type {function} */
        this.onSelectionChange = onSelectionChange;
      }

      /**
       * @param {ViewUpdate} update
       */
      update(update) {
        if (update.selectionSet) {
          const selection = update.state.selection;
          const ranges = selection.ranges;

          // Convert ranges to plain JavaScript objects if needed, or pass them directly
          /**
           * @param {any} range
           */
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
 * @param {EditorView} view The CodeMirror 6 EditorView
 * @param {string} xpath The XPath-like expression to resolve.
 * @returns {{from: number, to: number}|null} The `from` and `to` positions of the matching node, or null if not found.
 */
export function resolveXPath(view, xpath) {
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  const pathSegments = xpath.split("/").filter(segment => segment !== "");

  let cursor = tree.topNode.cursor();
  let foundNode = null;

  /**
   * @param {SyntaxNode} node
   * @param {number|null} [length=null]
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
 * @param {any} extension
 * @returns {boolean}
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
 * If the indentation cannot be reliably determined, it returns the default indentation.
 */
export function detectXmlIndentation(xmlString, defaultIndentation = "  ") {
  const lines = xmlString.split('\n');
  let tabIndentedLines = 0;
  let spaceIndentedLines = 0;
  /** @type {number[]} */
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
      return " ".repeat(spaceIndentations[0]);
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
        /**
         * @param {number} a
         * @param {number} b
         * @returns {number}
         */
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


/**
 * Creates a CodeMirror autocomplete data structure from a compressed version sent
 * by the server, which uses "#x" references which are reused at different places. This
 * includes "#Mx" references which are macros containing references. Returns the resolved version
 * with the string references replaced by the actual object references.
 *
 * @param {ReferenceMap} data Map to be resolved
 * @returns {ReferenceMap} Resolved map
 */
export function resolveDeduplicated(data) {
  // Create a copy to avoid modifying the original
  const resolved = JSON.parse(JSON.stringify(data));

  // Extract and resolve reference definitions (keys starting with #)
  /** @type {ReferenceMap} */
  const refs = {};
  Object.keys(resolved).forEach(key => {
    if (key.startsWith('#')) {
      const resolvedObj = /** @type {ReferenceMap} */ (resolved);
      const refsObj = /** @type {ReferenceMap} */ (refs);
      refsObj[key] = resolvedObj[key];
      delete resolvedObj[key];
    }
  });

  // Pre-resolve all references to create shared objects
  /** @type {ReferenceMap} */
  const resolvedRefs = {};

  // First pass: resolve simple references and macros
  Object.keys(refs).forEach(refId => {
    const refsTyped = /** @type {ReferenceMap} */ (refs);

    if (refId.startsWith('#M')) {
      // Macro reference - resolve to composite pattern
      const macroContent = refsTyped[refId];
      if (typeof macroContent === 'string' && macroContent.includes(' ')) {
        const refIds = macroContent.split(' ').filter(id => id.startsWith('#'));
        resolvedRefs[refId] = mergeReferences(refIds, refs);
      } else {
        resolvedRefs[refId] = refsTyped[refId];
      }
    } else {
      // Simple reference - use as-is (will be shared)
      resolvedRefs[refId] = refsTyped[refId];
    }
  });

  /**
   * Recursive function to resolve references using shared objects
   * @param {any} obj
   * @returns {any}
   */
  function resolveRefs(obj) {
    if (typeof obj === 'string' && obj.includes('#')) {
      if (obj.startsWith('#') && !obj.includes(' ')) {
        // Simple reference - return shared object and recursively resolve its contents
        const resolved = /** @type {ReferenceMap} */ (resolvedRefs)[obj];
        if (resolved) {
          return resolveRefs(resolved); // Recursively resolve the contents
        }
        return obj;
      } else if (obj.includes(' ')) {
        // Composite reference like "#1 #23 #44"
        const refIds = obj.split(' ').filter(id => id.startsWith('#'));
        return mergeReferences(refIds, resolvedRefs);
      }
      return obj;
    } else if (Array.isArray(obj)) {
      return obj.map(resolveRefs);
    } else if (obj && typeof obj === 'object') {
      /** @type {ReferenceMap} */
      const result = {};
      Object.keys(obj).forEach(key => {
        /** @type {ReferenceMap} */ (result)[key] = resolveRefs(/** @type {ReferenceMap} */ (obj)[key]);
      });
      return result;
    }
    return obj;
  }

  /**
   * Function to merge multiple references into a single object/array
   * @param {string[]} refIds
   * @param {ReferenceMap} refSource
   * @returns {any}
   */
  function mergeReferences(refIds, refSource) {
    /**
     * @param {string} id
     */
    const resolved = refIds.map(id => /** @type {ReferenceMap} */ (refSource)[id]).filter(Boolean);

    if (resolved.length === 0) return null;
    if (resolved.length === 1) return resolved[0]; // Share the single object

    // Determine merge strategy based on types
    const firstType = Array.isArray(resolved[0]) ? 'array' : typeof resolved[0];

    /**
     * @param {any} r
     */
    if (firstType === 'object' && resolved.every(r => typeof r === 'object' && !Array.isArray(r))) {
      // Merge objects - create new object but reference shared values where possible
      const merged = {};
      /**
       * @param {ReferenceMap} obj
       */
      resolved.forEach(obj => {
        Object.keys(obj).forEach(key => {
          if (key === 'doc' && /** @type {ReferenceMap} */ (merged)[key]) {
            // Merge documentation fields by concatenating with separator
            /** @type {ReferenceMap} */ (merged)[key] = /** @type {ReferenceMap} */ (merged)[key] + ' | ' + /** @type {ReferenceMap} */ (obj)[key];
          } else {
            /** @type {ReferenceMap} */ (merged)[key] = /** @type {ReferenceMap} */ (obj)[key]; // This shares the value reference
          }
        });
      });
      return merged;
    /**
     * @param {any} r
     */
    } else if (firstType === 'array' && resolved.every(r => Array.isArray(r))) {
      // Concatenate arrays and deduplicate
      /** @type {any[]} */
      const concatenated = /** @type {any[]} */ ([].concat(.../** @type {any[]} */ (resolved)));
      const seen = new Set();
      return concatenated.filter(item => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
    } else {
      // Mixed types - return as array
      return resolved;
    }
  }

  /**
   * Helper function to deduplicate arrays, preserving order
   * @param {any} arr
   * @returns {any}
   */
  function deduplicateArray(arr) {
    if (!Array.isArray(arr)) return arr;
    const seen = new Set();
    return arr.filter(item => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  /**
   * Helper function to recursively deduplicate values arrays in objects
   * @param {any} obj
   * @returns {any}
   */
  function deduplicateValues(obj) {
    if (Array.isArray(obj)) {
      return obj.map(deduplicateValues);
    } else if (obj && typeof obj === 'object') {
      const result = {};
      Object.keys(obj).forEach(key => {
        if (key === 'values' && Array.isArray(/** @type {ReferenceMap} */ (obj)[key])) {
          // Deduplicate values arrays specifically
          /** @type {ReferenceMap} */ (result)[key] = deduplicateArray(/** @type {ReferenceMap} */ (obj)[key]);
        } else {
          /** @type {ReferenceMap} */ (result)[key] = deduplicateValues(/** @type {ReferenceMap} */ (obj)[key]);
        }
      });
      return result;
    }
    return obj;
  }

  // Resolve all references in the main data
  Object.keys(resolved).forEach(key => {
    /** @type {ReferenceMap} */ (resolved)[key] = resolveRefs(/** @type {ReferenceMap} */ (resolved)[key]);
  });
  
  // Deduplicate all values arrays in the resolved data
  const finalResolved = deduplicateValues(resolved);

  return finalResolved;
}

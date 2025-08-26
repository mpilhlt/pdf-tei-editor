export class ApiError extends Error {}

export class UserAbortException extends Error {}

export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[$]/g, '\\$&');
}

/**
 * @typedef {object} ParsedXPathStepPartsSimple
 * @property {string} parentPath - The XPath path expression leading up to this specific step (e.g., '/root/child').
 * @property {string} finalStep - The core name part of the XPath step (e.g., 'elementName', 'prefix:elementName', 
 *    '@attribute', 'text()', '*').
 * @property {string} prefix - The namespace prefix associated with the 'finalStep' or the node test, 
 *    if present (e.g., 'prefix' from 'prefix:elementName').
 * @property {string} tagName - The local name part of the node test (e.g., 'elementName' from 'prefix:elementName', or 
 *    'attribute' from '@attribute'). Note: May be empty for node tests that don't have a name like `text()`.
 * @property {string} positionalPredicate - The final positional predicate
 * @property {number} index - The primary numerical index extracted from a positional predicate like `[1]` or 
 *    `[position()=n]`. Defaults to null if no explicit index predicate is found for the node type where position matters.
 * @property {string} indexParent - The xpath leading up to, but not including any existing positional predicate
 */

/**
 * @typedef {object} ParsedXPathStepParts
 * @property {string} input - The XPath as passed in, for debugging purposes only
 * @property {string} parentPath - The XPath path expression leading up to this specific step (e.g., '/root/child'). Includes the trailing separator if present, or is empty for relative paths starting with nodeTest.
 * @property {string} finalStep - The complete string representation of the last step, including node test and predicates (e.g., 'elementName[1]', '@attribute', 'text()').
 * @property {string} nodeTest - The core part of the XPath step before predicates (e.g., 'elementName', 'prefix:elementName', '@attribute', 'text()', '*', '.', '..').
 * @property {string} prefix - The namespace prefix associated with the node test, if present (e.g., 'prefix' from 'prefix:elementName'). Empty string if none.
 * @property {string} tagName - The local name part of the node test (e.g., 'elementName' from 'prefix:elementName', 'attribute' from '@attribute'). For functions like text(), this will be the function name ('text()'). For wildcards, '*'. For self/parent, '.' or '..'. Empty string if the node test structure doesn't have a name part.
 * @property {string} predicates - The full string containing all predicates associated with the last step (e.g., '[1][@id="xyz"]'). Empty string if none.
 * @property {string} nonIndexPredicates - The predicates that qualify the tagName but do not contain the index of the node among siblings
 * @property {number | null} index - The primary numerical index extracted from the *first* positional predicate like `[1]` or `[position()=n]` found in the predicates. Defaults to null if no such predicate is found or can't be parsed.
 * @property {string} pathBeforePredicates - The xpath leading up to, but not including any predicates for this step (i.e., parentPath + nodeTest).
 */

/**
 * Parses an XPath expression focusing on the last step.
 * Identifies the parent path, the full string representation of the last step,
 * separates the node test from predicates, identifies node test components
 * (prefix, local name/wildcard/function/special name), and extracts
 * the index from the first simple positional predicate if present.
 *
 * @param {string} xpath An XPath expression (e.g., '/html/body/div[1]/span[@class="text"][position()=2]/text()')
 * @returns {ParsedXPathStepParts} An object containing the parsed components of the XPath step.
 * @throws {Error} If the xpath is empty, ends in a separator, or cannot be parsed due to syntax errors (mismatched brackets, invalid node test).
 */
export function parseXPath(xpath) {
  if (!xpath) {
    throw new Error("No xpath given");
  }

  // --- Step 1: Find the split point for the last step ---
  // Iterate backwards to find the last '/' or '//' that is outside quotes and brackets.
  // This correctly identifies the full final step string including all its predicates.
  let lastStepStartIndex = 0; // Assume relative path by default
  let bracketDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = xpath.length - 1; i >= 0; i--) {
    const char = xpath[i];

    // Check for quotes first
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue; // Move to the next character
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue; // Move to the next character
    }

    // If not inside quotes, check for brackets and separators
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === ']') {
        bracketDepth++;
      } else if (char === '[') {
        bracketDepth--;
        if (bracketDepth < 0) {
           throw new Error(`Cannot parse xpath: Mismatched '[' detected near index ${i} in "${xpath}"`);
        }
      } else if (bracketDepth === 0) {
        // Found a character outside quotes and depth-0 brackets
        if (char === '/') {
           // Found a separator
           if (i > 0 && xpath[i-1] === '/') {
               lastStepStartIndex = i - 1; // Start of //
           } else {
               lastStepStartIndex = i;     // Start of /
           }
           break; // Found the last separator, we can stop
        }
      }
    }
  }

  // If bracketDepth is not zero at the end, quotes/brackets are mismatched.
  if (bracketDepth !== 0) {
       throw new Error(`Cannot parse xpath: Mismatched brackets detected in "${xpath}"`);
  }

  // --- Step 1.5: Determine parentPath and finalStepString based on the split point ---
  let finalStepString;
  let parentPath;
  let separatorLength = 0; // Length of the separator found (1 for '/', 2 for '//')

  // If lastStepStartIndex is > 0, the loop found the start of the separator ('/' or '//')
  if (lastStepStartIndex > 0) {
      // Determine if it was '/' or '//'
      if (xpath[lastStepStartIndex] === '/') { // It must be a '/'
           if (lastStepStartIndex > 0 && xpath[lastStepStartIndex - 1] === '/') {
               separatorLength = 2; // Was '//', lastStepStartIndex was set to i-1
           } else {
               separatorLength = 1; // Was '/', lastStepStartIndex was set to i
           }
      } else {
          // Should not happen based on loop logic finding '/' at depth 0
          throw new Error(`Internal parsing error: Separator character expected at index ${lastStepStartIndex} in "${xpath}"`);
      }
       parentPath = xpath.substring(0, lastStepStartIndex + separatorLength);
       finalStepString = xpath.substring(lastStepStartIndex + separatorLength);

  } else if (xpath.startsWith('/') || xpath.startsWith('//')) {
      // No separator found by the loop > index 0, but xpath starts with '/' or '//'.
      // This means the whole path is the last step, but it's absolute or descendant.
      // The separator is at the beginning.
      if (xpath.startsWith('//')) {
          separatorLength = 2;
      } else { // Starts with single /
          separatorLength = 1;
      }
       // parentPath includes the leading separator(s)
       parentPath = xpath.substring(0, separatorLength);
       // finalStepString is everything after the leading separator(s)
       finalStepString = xpath.substring(separatorLength);

  } else {
      // No separator found > index 0, and doesn't start with / or //.
      // It's a relative path step (e.g., "div", "@id", "../foo").
      parentPath = "";
      finalStepString = xpath;
  }


  // Handle the edge case where finalStepString is empty, which is not a valid step itself.
  if (!finalStepString) {
       // This happens for paths like '/', '/a/b/', '/a/b//'
       throw new Error(`Cannot parse xpath: "${xpath}" results in an empty final step.`);
  }


  // --- Step 2: Split finalStepString into node test and predicates ---
  // Find the index of the *first* '[' that is not inside quotes or brackets *within* finalStepString.
  let predicatesStartIndex = finalStepString.length; // Assume no predicates initially
  bracketDepth = 0; // Reset for scanning finalStepString
  inSingleQuote = false; // Reset
  inDoubleQuote = false; // Reset

  for (let i = 0; i < finalStepString.length; i++) {
      const char = finalStepString[i];

      // Check for quotes
      if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
          continue;
      } else if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
          continue;
      }

      // If not inside quotes, check for brackets
      if (!inSingleQuote && !inDoubleQuote) {
          if (char === '[') {
              if (bracketDepth === 0) {
                  // Found the first top-level predicate start
                  predicatesStartIndex = i;
                  break; // Stop scanning, found the split point
              }
              bracketDepth++;
          } else if (char === ']') {
               bracketDepth--;
               // Basic check, more rigorous validation of predicate syntax isn't the goal here.
               if (bracketDepth < 0) {
                    throw new Error(`Cannot parse xpath: Mismatched ']' detected in predicates "${finalStepString.substring(predicatesStartIndex)}" from "${xpath}"`);
               }
          }
      }
  }

   // Check for mismatched brackets within the predicates part (only if predicates exist)
   if (predicatesStartIndex < finalStepString.length && bracketDepth !== 0) {
        throw new Error(`Cannot parse xpath: Unbalanced brackets detected in predicates "${finalStepString.substring(predicatesStartIndex)}" from "${xpath}"`);
   }


  const nodeTestString = finalStepString.substring(0, predicatesStartIndex);
  const predicates = finalStepString.substring(predicatesStartIndex);

  // --- Step 3: Parse nodeTestString ---
  // Regex specifically for the node test part (no predicates).
  // Catches: @?, prefix:?, name, *, text(), node(), comment(), processing-instruction(), ., ..
  // Group indices (mapping to nodeTestMatch array indices):
  // [0]: Full match (same as nodeTestString)
  // [1]: (@?)                                        --> nodeTestMatch[1] (isAttribute)
  // [2]: ([a-zA-Z0-9-_.:*]+)                         --> nodeTestMatch[2] (prefix)
  // [3]: ([a-zA-Z0-9-_.:*]+|\*)                      --> nodeTestMatch[3] (name/wildcard)
  // [4]: (text\(\)|comment\(\)|processing-instruction\(\)|node\(\)) --> nodeTestMatch[4] (function name)
  // [5]: (\.|\.\.)                                    --> nodeTestMatch[5] (. or ..)
  const nodeTestRegex = /^(?:(@?)(?:(?:([a-zA-Z0-9-_.:*]+):)?([a-zA-Z0-9-_.:*]+|\*))|(text\(\)|comment\(\)|processing-instruction\(\)|node\(\))|(\.|\.\.))$/;
  const nodeTestMatch = nodeTestString.match(nodeTestRegex);

  if (!nodeTestMatch) {
       // This means the nodeTestString part (e.g., "biblStruct" or "@id" or "text()")
       // did not match any known node test pattern. This indicates a syntax error
       // in the node test part itself.
       throw new TypeError(`Cannot parse node test "${nodeTestString}" from XPath "${xpath}". Node test did not match expected pattern.`);
  }

  // Correctly assign variables based on the regex groups
  // Use default values for safety if a group is unexpectedly missing
  const matchedPrefix = nodeTestMatch[2] || '';   // Group 2: Optional prefix (if element/attribute)
  const matchedName = nodeTestMatch[3]; // Group 3: Local name / wildcard (if element/attribute)
  const matchedFunctionName = nodeTestMatch[4];   // Group 4: Function name (if node type function)
  const matchedSpecialStep = nodeTestMatch[5];    // Group 5: '.' or '..'


  // Determine the 'tagName' property value based on which part matched
  let finalTagName = ''; // Initialise as empty string as requested
  if (matchedSpecialStep) {
      finalTagName = matchedSpecialStep; // Assigns '.', '..'
  } else if (matchedFunctionName) {
      finalTagName = matchedFunctionName; // Assigns 'text()', 'node()', etc.
  } else if (matchedName !== undefined) {
       finalTagName = matchedName; // Assigns 'elementName', 'attributeName', '*'
  }
  // If none matched (shouldn't happen for valid nodeTestString), finalTagName remains ''.


  // --- Step 4: Extract index from predicates string ---
  // Look for the *first* occurrence of [number] or [position()=number]
  // within the 'predicates' string.
  const indexRegex = /\[\s*(?:(\d+)|position\(\)\s*=\s*(\d+))\s*\]/;
  const indexMatch = predicates.match(indexRegex);
  let nonIndexPredicates = predicates

  let finalIndex = null; // Use a different variable name for the final property value
  if (indexMatch) {
      // indexMatch[1] is the number from [number]
      // indexMatch[2] is the number from [position()=number]
      const indexStr = indexMatch[1] || indexMatch[2];
      const parsedIndex = parseInt(indexStr, 10);
      if (!isNaN(parsedIndex)) {
          finalIndex = parsedIndex;
      }
      // remove index predicates
      nonIndexPredicates = predicates.replace(indexMatch[0], '')
  }

  // --- Step 5: Calculate pathBeforePredicates ---
  const finalPathBeforePredicates = parentPath + nodeTestString;

  return {
    input: xpath, 
    parentPath,
    finalStep: finalStepString,
    nodeTest: nodeTestString,
    prefix: matchedPrefix,
    tagName: finalTagName,
    predicates,
    nonIndexPredicates,
    index: finalIndex,
    pathBeforePredicates: finalPathBeforePredicates,
  };
}

/**
 * Checks if the set of nodes selected by xpath1 is a subset of the
 * set of nodes selected by xpath2, within the context of a specific
 * XML document root node.
 *
 * @param {string} xpath1 The XPath expression whose result set is checked for being a subset.
 * @param {string} xpath2 The XPath expression whose result set is checked for being a superset.
 * @param {Document | Element} rootNode The XML document or element node within which to evaluate the XPath expressions.
 * @param {XPathNSResolver | null} [namespaceResolver=null] An optional function to resolve namespaces (important for XML).
 * @returns {boolean} True if every node selected by xpath1 is also selected by xpath2, false otherwise or if evaluation fails.
 */
export function isXPathSubset(xpath1, xpath2, rootNode, namespaceResolver = null) {
  if (!rootNode) {
      console.error("XPath subset check requires a root node (Document or Element).");
      return false;
  }

  try {
      // Evaluate the first XPath expression (potential subset)
      // @ts-ignore
      const result1 = rootNode.evaluate(
          xpath1,
          rootNode, // Context node
          namespaceResolver,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, // Get nodes as a snapshot
          null // No need to reuse a result object
      );

      // If xpath1 selects no nodes, its result set is the empty set,
      // which is a subset of any set, so return true.
      if (result1.snapshotLength === 0) {
          return true;
      }

      // Evaluate the second XPath expression (potential superset)
      // @ts-ignore
      const result2 = rootNode.evaluate(
          xpath2,
          rootNode, // Context node
          namespaceResolver,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, // Get nodes as a snapshot
          null // No need to reuse a result object
      );

      // If xpath1 selected nodes, but xpath2 selected no nodes,
      // xpath1's set cannot be a subset of xpath2's empty set.
      if (result2.snapshotLength === 0) {
           return false;
      }


      // Create a Set of nodes from the second result for efficient lookup
      const nodes2Set = new Set();
      for (let i = 0; i < result2.snapshotLength; i++) {
          nodes2Set.add(result2.snapshotItem(i));
      }

      // Check if every node in the first result is present in the set of the second result
      for (let i = 0; i < result1.snapshotLength; i++) {
          const node1 = result1.snapshotItem(i);
          if (!nodes2Set.has(node1)) {
              // Found a node from xpath1 that is NOT in xpath2's set
              return false;
          }
      }

      // If the loop completed, all nodes from xpath1 were found in xpath2's set
      return true;

  } catch (error) {
      // Handle potential errors during XPath evaluation (e.g., invalid syntax)
      console.error(`Error evaluating XPath expressions: ${xpath1} or ${xpath2}`, error);
      // If evaluation fails for either, we can't determine the subset relationship
      return false;
  }
}


function dashToCamelCase(str) {
  if (typeof str !== 'string' || str.length === 0) {
    return "";
  }

  const parts = str.split('-');
  let camelCaseResult = "";
  let isFirstPartProcessed = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.length === 0) {
      continue;
    }

    if (!isFirstPartProcessed) {
      camelCaseResult += part;
      isFirstPartProcessed = true;
    } else {
      camelCaseResult += part[0].toUpperCase() + part.slice(1);
    }
  }

  return camelCaseResult;
}
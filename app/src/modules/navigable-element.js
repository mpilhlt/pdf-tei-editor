/**
 * Creates navigable element trees by exposing named descendants as direct properties.
 * No browser-specific imports — safe to use in Node.js unit tests.
 */

/**
 * @param {Element|Document} node
 * @returns {{ [x: string]: Element }}
 */
function findNamedDescendants(node) {
  // Tags that use `name` for element-specific purposes (e.g. icon identifier),
  // not as a navigation label. Use `data-name` on these when a label is needed.
  const skipNameAttrTags = ['sl-icon', 'sl-icon-button']
  const results = {};

  /**
   * @param {Element|Document} currentNode
   */
  function traverse(currentNode) {
    if (!currentNode || !currentNode.childNodes) {
      return;
    }

    for (let i = 0; i < currentNode.childNodes.length; i++) {
      /** @type {Element} */
      const childNode = /** @type {Element} */(currentNode.childNodes[i]);
      if (childNode.nodeType === Node.ELEMENT_NODE) {
        const tag = childNode.tagName?.toLowerCase()
        const nameAttribute = (!skipNameAttrTags.includes(tag) && childNode.getAttribute("name")) || childNode.getAttribute("data-name");

        if (nameAttribute && !Object.prototype.hasOwnProperty.call(results, nameAttribute)) {
          // @ts-ignore
          results[nameAttribute] = childNode;
        } else {
          traverse(childNode);
        }
      }
    }
  }
  traverse(node);
  return results;
}

/**
 * Creates a navigable element by adding named descendant elements as properties.
 * Each property gives direct access to the DOM element (which is also the navigation object).
 * You must be careful to use names that do not override existing properties.
 *
 * @template {Element|Document} T
 * @param {T} node The element to enhance with navigation
 * @returns {T & Record<string, any>} The element with added navigation properties
 */
export function createNavigableElement(node) {
  const namedDescendants = findNamedDescendants(node);
  for (let name in namedDescendants) {
    namedDescendants[name] = createNavigableElement(namedDescendants[name]);
  }
  return Object.assign(node, namedDescendants);
}

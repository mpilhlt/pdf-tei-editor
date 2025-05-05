export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[$]/g, '\\$&');
}

/**
 * Returns information on the given xpath
 * @param {string} xpath An xpath expression
 * @returns {Object}
 */
export function xpathInfo(xpath) {
  if (!xpath) {
    throw new Error("No xpath given")
  }

  // the last segment of the xpath, with final selector
  const basename = xpath.split("/").pop() 

  // everything before the final tag name (or empty string)
  const parentPath = xpath.slice(0, xpath.length - basename.length)  

  // match the basename
  const xpathRegex = /^(?:(\w+):)?(\w+)(.*)?$/;
  const match = basename.match(xpathRegex);
  
  if (!match) {
    throw new TypeError(`Cannot parse xpath: ${xpath}`)
  }

  // namespace prefix (e.g., "tei") or empty string
  const prefix = match[1] || "" 
  
  // tag name (e.g., "biblStruct")
  const tagName = match[2]  

  // the final child/attribute selector (e.g., "[1]", "[@status='verified']") or empty string
  const finalSelector = match[3] || "" 

  // final index
  const m = xpath.match(/(.+?)\[(\d+)\]$/)
  const index = (m && !isNaN(parseInt(m[2]))) ? parseInt(m[2]) : null 
  
  // xpath without index
  const beforeIndex = index ? xpath.slice(0, -finalSelector.length) : xpath

  return { parentPath, basename, prefix, tagName, finalSelector, index, beforeIndex };
}
import { remote_xmllint } from './client.js'
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

export async function lintSource(view) {
  // get text from document
  const doc = view.state.doc;
  const xml = doc.toString();
  if (xml == "") {
    return [];
  }

  const { errors } = await remote_xmllint(xml);

  // convert xmllint errors to Diagnostic objects
  const diagnostics = errors.map(error => {
    let from, to;
    if (error.line) {
      ({from, to} = doc.line(error.line))
      from += error.col

    } else if (error.path) {
      // {"reason": "Unexpected child with tag 'tei:imprint' at position 4. Tag 'tei:title' expected.", 
      // "path": "/TEI/standOff/listBibl/biblStruct[8]/monogr"}  
      const pos = resolveXPath(view, error.path)
      if (!pos) {
        console.warn(`Could not locate ${error.path} in syntax tree.`)
        return null
      }
      ({ from, to } = pos);
    } else {
      console.warn("Invalid response from remote validation:", error)
      return null
    }
    return { from, to, severity: "error", message: error.reason };
  }).filter(Boolean);

  if (diagnostics.length > 0) {
    console.log(`${diagnostics.length} linter error(s) found.`)
  }
  return diagnostics;
}

/**
 * Resolves a simple XPath-like expression against a CodeMirror 6 syntax tree
 * to find the position of the target node.
 *
 * The XPath only supports direct and indexed children (e.g., "/TEI/standOff/listBibl/biblStruct[8]/monogr").
 *
 * @param view {EditorView} The CodeMirror 6 EditorView
 * @param xpath The XPath-like expression to resolve.
 * @returns The `from` and `to` positions of the matching node, or null if not found.
 */
function resolveXPath(view, xpath) {
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  const pathSegments = xpath.split("/").filter(segment => segment !== "");

  let cursor = tree.topNode.cursor();
  let foundNode = null;

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
        if (tagNameNode.name === "TagName" && text(tagNameNode) === tagName) {
          if (childIndex === index) {
            found = true;
            foundNode = element;
            break;
          }
          childIndex++;
        }
      }
    } while (cursor.nextSibling());

    if (!found) {
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
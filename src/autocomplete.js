/**
 * Walks the Lezer Syntax upwards to find all tag names
 * @param {Object} node 
 * @param {EditorState} state 
 * @returns {Array<>}
 */
function getParentTagNames(node, state) {
  const tagNames = [];
  let parentNode = node.parent;
  while (parentNode) {
    if (parentNode.name === "Element") {
      const tagPortion = state.doc.sliceString(parentNode.from, parentNode.to);
      const match = tagPortion.match(/^<([a-zA-Z0-9:]+)/);
      if (match) {
        tagNames.push(match[1]); // Add the captured tag name to the list
      }
    }
    parentNode = parentNode.parent;
  }
  return tagNames;
}

/**
 * Given a data structure containing permissible children and attributes of
 * nodes with a given tag, create the completionSource data for autocompletion
 * @param {*} tagData 
 * @returns 
 */
export function createCompletionSource(tagData) {
  return (context) => {
    const state = context.state;
    const pos = context.pos;
    let node = syntaxTree(state).resolveInner(pos, -1);
    let type = node.type.name;
    let text = context.state.sliceDoc(node.from, context.pos);
    let options = [];
    const parentTags = getParentTagNames(node, state);
    let completionType = "keyword";

    switch (type) {
      case "StartTag":
        options = tagData[parentTags[0]]?.children || [];
        break;
      case "TagName":
        options = tagData[parentTags[1]]?.children || [];
        break;
      case "OpenTag":
      case "AttributeName":
        options = Object.keys(tagData[parentTags[0]]?.attrs || {})
          .map(displayLabel => ({
            displayLabel,
            label: `${displayLabel}=""`,
            type: "property",
            apply: (view, completion, from, to) => {
              view.dispatch({
                changes: { from, to, insert: completion.label },
                selection: { anchor: from + completion.label.length - 1 }
              });
              // start new autocomplete
              setTimeout(() => startCompletion(view), 20);
            }
          }));
        break;
      case "AttributeValue":
        const attributeNode = node.prevSibling?.prevSibling;
        if (!attributeNode) break;
        const attributeTag = context.state.sliceDoc(attributeNode.from, attributeNode.to);
        const attrs = tagData[parentTags[0]]?.attrs;
        options = (attrs && attrs[attributeTag]) || [];
        options = options.map(option => ({
          label: option,
          type: "property",
          apply: (view, completion, from, to) => {
            view.dispatch({
              changes: { from, to, insert: completion.label },
              selection: { anchor: to + completion.label.length + 1 }, // Move cursor after the closing quote
            });
          }
        }));
        break;
    }

    if (options.length === 0) {
      return null;
    }

    // Suggest from cursor position for StartTag/OpenTag.
    const from = ["StartTag", "OpenTag", "AttributeValue"].includes(type) ? pos : node.from;
    const to = pos;

    // convert string options to completionResult objects
    options = options.map(label => typeof label === "string" ? ({ label, type: completionType }) : label);

    return {
      from, to, options,
      validFor: /^[\w@:]*$/
    };
  };
}

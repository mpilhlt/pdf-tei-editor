/**
 * @import {SyntaxNode} from '@lezer/common'
 * @import {EditorState} from '@codemirror/state'
 */

import { syntaxTree } from "@codemirror/language";
import { startCompletion } from "@codemirror/autocomplete";

/**
 * Creates a delayed info function that shows documentation after a timeout
 * only if the user hasn't changed the selection
 * @param {string} doc - The documentation text to show
 * @returns {Function} Async function that returns documentation with delay
 */
function createDelayedInfo(doc) {
  return function() {
    return new Promise((resolve) => {
      const delay = 800; // 800ms delay before showing documentation
      
      setTimeout(() => {
        // Create a DOM node containing the documentation
        const div = document.createElement('div');
        div.textContent = doc;
        div.style.maxWidth = '300px';
        div.style.padding = '8px';
        div.style.lineHeight = '1.4';
        resolve(div);
      }, delay);
    });
  };
}

/**
 * Walks the Lezer Syntax upwards to find all tag names
 * @param {SyntaxNode} node 
 * @param {EditorState} state 
 * @returns {string[]}
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
    //let text = context.state.sliceDoc(node.from, context.pos);
    let options = [];
    const parentTags = getParentTagNames(node, state);
    let completionType = "keyword";

    switch (type) {
      case "StartTag":
        options = (tagData[parentTags[0]]?.children || []).map(childName => {
          const childData = tagData[childName];
          const doc = childData?.doc;
          return {
            label: childName,
            type: "keyword",
            detail: doc ? (doc.length > 50 ? doc.substring(0, 47) + "..." : doc) : undefined,
            info: doc ? createDelayedInfo(doc) : undefined
          };
        });
        break;
      case "TagName":
        options = (tagData[parentTags[1]]?.children || []).map(childName => {
          const childData = tagData[childName];
          const doc = childData?.doc;
          return {
            label: childName,
            type: "keyword",
            detail: doc ? (doc.length > 50 ? doc.substring(0, 47) + "..." : doc) : undefined,
            info: doc ? createDelayedInfo(doc) : undefined
          };
        });
        break;
      case "OpenTag":
      case "AttributeName":
        options = Object.keys(tagData[parentTags[0]]?.attrs || {})
          .map(attrName => {
            const attrData = tagData[parentTags[0]].attrs[attrName];
            const doc = (typeof attrData === 'object' && attrData.doc) ? attrData.doc : undefined;
            
            return {
              displayLabel: attrName,
              label: `${attrName}=""`,
              type: "property",
              detail: doc ? (doc.length > 30 ? doc.substring(0, 27) + "..." : doc) : undefined,
              info: doc ? createDelayedInfo(doc) : undefined,
              apply: (view, completion, from, to) => {
                view.dispatch({
                  changes: { from, to, insert: completion.label },
                  selection: { anchor: from + completion.label.length - 1 }
                });
                // start new autocomplete
                setTimeout(() => startCompletion(view), 20);
              }
            };
          });
        break;
      case "AttributeValue":
        const attributeNode = node.prevSibling?.prevSibling;
        if (!attributeNode) break;
        const attributeTag = context.state.sliceDoc(attributeNode.from, attributeNode.to);
        const attrs = tagData[parentTags[0]]?.attrs;
        const attrData = attrs && attrs[attributeTag];
        
        // Handle both old format (array) and new format (object with values and doc)
        let values = [];
        let attrDoc = undefined;
        
        if (Array.isArray(attrData)) {
          values = attrData;
        } else if (typeof attrData === 'object' && attrData) {
          values = attrData.values || [];
          attrDoc = attrData.doc;
        }
        
        options = values.map(value => ({
          label: value,
          type: "property",
          detail: attrDoc ? (attrDoc.length > 40 ? attrDoc.substring(0, 37) + "..." : attrDoc) : undefined,
          info: attrDoc ? createDelayedInfo(attrDoc) : undefined,
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

    // convert string options to completionResult objects (only for legacy format)
    options = options.map(option => {
      if (typeof option === "string") {
        return { label: option, type: completionType };
      }
      return option;
    });

    return {
      from, to, options,
      validFor: /^[\w@:]*$/
    };
  };
}

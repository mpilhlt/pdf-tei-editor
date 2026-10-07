#!/usr/bin/env node

/**
 * @testCovers app/src/modules/tei-header-form.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildFieldTree } from '../../../app/src/modules/tei-header-form.js';

/** @type {import('../../../app/src/modules/api-client-v1.js').TeiHeaderStructureResponse} */
const FIXTURE_STRUCTURE = {
  roots: ['titleStmt'],
  tags: {
    titleStmt: {
      description: 'title statement',
      children: ['title'],
      attributes: [],
      childCardinality: { title: { required: true, repeatable: false } }
    },
    title: {
      description: 'the title of a work',
      children: [],
      attributes: [{ name: 'level', values: ['a', 'm', 'j'], required: false }],
      childCardinality: {}
    }
  }
};

describe('buildFieldTree', () => {
  it('builds a nested tree with leaf fields and required/repeatable flags', () => {
    const tree = buildFieldTree(FIXTURE_STRUCTURE);
    assert.strictEqual(tree.length, 1);
    const [titleStmt] = tree;
    assert.strictEqual(titleStmt.tag, 'titleStmt');
    assert.strictEqual(titleStmt.children.length, 1);
    const [title] = titleStmt.children;
    assert.strictEqual(title.tag, 'title');
    assert.strictEqual(title.isLeaf, true);
    assert.strictEqual(title.required, true);
    assert.strictEqual(title.repeatable, false);
    assert.strictEqual(title.attributes[0].name, 'level');
  });

  it('caps recursion depth at 6 levels to guard against schema cycles', () => {
    /** @type {any} */
    const cyclicStructure = {
      roots: ['a'],
      tags: {
        a: { description: null, children: ['a'], attributes: [], childCardinality: { a: { required: false, repeatable: true } } }
      }
    };
    const tree = buildFieldTree(cyclicStructure);
    let depth = 0;
    let node = tree[0];
    while (node.children && node.children[0]) {
      node = node.children[0];
      depth += 1;
    }
    assert.ok(depth <= 6, `depth was ${depth}, expected <= 6`);
  });
});

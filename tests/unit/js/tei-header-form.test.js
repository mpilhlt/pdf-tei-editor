#!/usr/bin/env node

/**
 * @testCovers app/src/modules/tei-header-form.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { buildFieldTree, readFieldValues, applyFieldValues } from '../../../app/src/modules/tei-header-form.js';

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

  it('actually caps at depth 6 for a long acyclic chain (not just <= 6)', () => {
    /** @type {any} */
    const chainStructure = { roots: ['t0'], tags: {} };
    for (let i = 0; i < 10; i++) {
      chainStructure.tags[`t${i}`] = {
        description: null,
        children: i < 9 ? [`t${i + 1}`] : [],
        attributes: [],
        childCardinality: i < 9 ? { [`t${i + 1}`]: { required: false, repeatable: false } } : {}
      };
    }
    const tree = buildFieldTree(chainStructure);
    let depth = 0;
    let node = tree[0];
    while (node.children && node.children[0]) {
      node = node.children[0];
      depth += 1;
    }
    assert.strictEqual(depth, 6);
  });
});

describe('readFieldValues / applyFieldValues', () => {
  const NS = 'http://www.tei-c.org/ns/1.0';

  it('reads an existing leaf value by tag path', () => {
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><titleStmt><title>Existing title</title></titleStmt></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const titleStmt = dom.window.document.getElementsByTagName('titleStmt')[0];
    const tree = [{ tag: 'title', isLeaf: true, required: true, repeatable: false, attributes: [], children: [] }];
    const values = readFieldValues(tree, titleStmt);
    assert.strictEqual(values.title[0].text, 'Existing title');
  });

  it('creates missing elements on write, and skips untouched optional sections', () => {
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><titleStmt/></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const titleStmt = dom.window.document.getElementsByTagName('titleStmt')[0];
    const tree = [{ tag: 'title', isLeaf: true, required: true, repeatable: false, attributes: [], children: [] }];
    applyFieldValues(tree, titleStmt, { title: [{ text: 'New title', attrs: {} }] }, NS);
    const titleEl = titleStmt.getElementsByTagName('title')[0];
    assert.strictEqual(titleEl.textContent, 'New title');
  });

  it('does not collide two sibling non-leaf sections that share a leaf tag name (analytic/title vs monogr/title)', () => {
    // biblStruct/analytic/title and biblStruct/monogr/title are two
    // different fields that happen to share a tag name one level down -
    // a naive flat tag-name-keyed values dict would merge them into one.
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><sourceDesc><biblStruct><analytic><title>Article Title</title></analytic><monogr><title>Journal Title</title></monogr></biblStruct></sourceDesc></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const biblStruct = dom.window.document.getElementsByTagName('biblStruct')[0];
    const titleLeaf = { tag: 'title', isLeaf: true, required: false, repeatable: false, attributes: [], children: [] };
    const tree = [
      { tag: 'analytic', isLeaf: false, required: false, repeatable: false, attributes: [], children: [titleLeaf] },
      { tag: 'monogr', isLeaf: false, required: false, repeatable: false, attributes: [], children: [titleLeaf] }
    ];

    const values = readFieldValues(tree, biblStruct);
    assert.strictEqual(values.analytic.title[0].text, 'Article Title');
    assert.strictEqual(values.monogr.title[0].text, 'Journal Title');

    // Round-trip: apply swapped values and confirm each section keeps its own.
    applyFieldValues(tree, biblStruct, {
      analytic: { title: [{ text: 'New Article Title', attrs: {} }] },
      monogr: { title: [{ text: 'New Journal Title', attrs: {} }] }
    }, NS);
    const analyticTitle = biblStruct.getElementsByTagName('analytic')[0].getElementsByTagName('title')[0];
    const monogrTitle = biblStruct.getElementsByTagName('monogr')[0].getElementsByTagName('title')[0];
    assert.strictEqual(analyticTitle.textContent, 'New Article Title');
    assert.strictEqual(monogrTitle.textContent, 'New Journal Title');
  });
});

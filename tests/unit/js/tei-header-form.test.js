#!/usr/bin/env node

/**
 * @testCovers app/src/modules/tei-header-form.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { buildFieldTree, readFieldValues, applyFieldValues, getMainInput, MAX_DEPTH } from '../../../app/src/modules/tei-header-form.js';

// applyFieldValues() references the bare global `Node` (e.g. Node.TEXT_NODE),
// same as app/src/modules/xml-utils.js and friends - not available in plain
// Node.js, so tests exercising that path need it set globally first (same
// pattern as tests/unit/js/xmleditor-edit-guard.test.js).
global.Node = new JSDOM('<!DOCTYPE html>').window.Node;

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

  it('caps recursion depth at MAX_DEPTH levels to guard against schema cycles', () => {
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
    assert.ok(depth <= MAX_DEPTH, `depth was ${depth}, expected <= ${MAX_DEPTH}`);
  });

  it('actually caps at MAX_DEPTH for a long acyclic chain (not just <= MAX_DEPTH)', () => {
    /** @type {any} */
    const chainStructure = { roots: ['t0'], tags: {} };
    const chainLength = MAX_DEPTH + 4; // comfortably longer than MAX_DEPTH, to prove truncation actually happens
    for (let i = 0; i < chainLength; i++) {
      chainStructure.tags[`t${i}`] = {
        description: null,
        children: i < chainLength - 1 ? [`t${i + 1}`] : [],
        attributes: [],
        childCardinality: i < chainLength - 1 ? { [`t${i + 1}`]: { required: false, repeatable: false } } : {}
      };
    }
    const tree = buildFieldTree(chainStructure);
    let depth = 0;
    let node = tree[0];
    while (node.children && node.children[0]) {
      node = node.children[0];
      depth += 1;
    }
    assert.strictEqual(depth, MAX_DEPTH);
  });

  it('expands a tag reachable from multiple parents only once, as a leaf on later occurrences', () => {
    // `shared` is a child of both `a` and `b` - without global-expand-once
    // tracking, each occurrence would independently re-expand `shared`'s
    // own subtree, which is combinatorial for a real schema's richly
    // cross-referenced vocabulary (see buildNode()'s docstring).
    /** @type {any} */
    const structure = {
      roots: ['a', 'b'],
      tags: {
        a: { description: null, children: ['shared'], attributes: [], childCardinality: { shared: { required: false, repeatable: false } } },
        b: { description: null, children: ['shared'], attributes: [], childCardinality: { shared: { required: false, repeatable: false } } },
        shared: { description: null, children: ['leaf'], attributes: [], childCardinality: { leaf: { required: false, repeatable: false } } },
        leaf: { description: null, children: [], attributes: [], childCardinality: {} }
      }
    };
    const [a, b] = buildFieldTree(structure);
    const sharedUnderA = a.children.find((n) => n.tag === 'shared');
    const sharedUnderB = b.children.find((n) => n.tag === 'shared');
    assert.strictEqual(sharedUnderA.isLeaf, false, 'first occurrence should expand normally');
    assert.strictEqual(sharedUnderA.children.length, 1);
    assert.strictEqual(sharedUnderB.isLeaf, true, 'second occurrence should be forced to a leaf');
    assert.strictEqual(sharedUnderB.children.length, 0);
  });

  it('documents that MAX_DEPTH currently makes biblStruct/analytic and biblStruct/monogr unreachable for their own children (known limitation, see MAX_DEPTH\'s docstring)', () => {
    // Shaped like the real bundled core schema: sourceDesc (root, depth 0)
    // -> biblStruct (depth 1) -> analytic/monogr (depth 2) -> title
    // (depth 3, never reached). At the current MAX_DEPTH=2,
    // `atMaxDepth = depth >= MAX_DEPTH` fires AT depth 2, forcing
    // analytic/monogr to isLeaf=true before their own title/author
    // children are ever expanded - the real-schema consequence of
    // MAX_DEPTH's trade-off (see that constant's docstring). This means
    // Task 9's analytic/monogr title-disambiguation feature (see the
    // "does not collide two sibling non-leaf sections..." test below) is
    // NOT reachable through buildFieldTree() against the real schema
    // today, even though that test's hand-constructed FieldNode tree
    // (bypassing buildFieldTree()/MAX_DEPTH entirely) proves the
    // disambiguation LOGIC itself is correct. If MAX_DEPTH is ever
    // changed, re-check this test and reconsider that trade-off rather
    // than just updating the asserted depth.
    /** @type {any} */
    const structure = {
      roots: ['sourceDesc'],
      tags: {
        sourceDesc: { description: null, children: ['biblStruct'], attributes: [], childCardinality: { biblStruct: { required: false, repeatable: false } } },
        biblStruct: { description: null, children: ['analytic', 'monogr'], attributes: [], childCardinality: { analytic: { required: false, repeatable: false }, monogr: { required: false, repeatable: false } } },
        analytic: { description: null, children: ['title'], attributes: [], childCardinality: { title: { required: false, repeatable: false } } },
        monogr: { description: null, children: ['title'], attributes: [], childCardinality: { title: { required: false, repeatable: false } } },
        title: { description: null, children: [], attributes: [], childCardinality: {} }
      }
    };
    const [sourceDesc] = buildFieldTree(structure);
    const biblStruct = sourceDesc.children.find((n) => n.tag === 'biblStruct');
    const analytic = biblStruct.children.find((n) => n.tag === 'analytic');
    const monogr = biblStruct.children.find((n) => n.tag === 'monogr');
    assert.strictEqual(analytic.isLeaf, true, 'analytic should currently be forced to a leaf at MAX_DEPTH');
    assert.strictEqual(analytic.children.length, 0);
    assert.strictEqual(monogr.isLeaf, true, 'monogr should currently be forced to a leaf at MAX_DEPTH');
    assert.strictEqual(monogr.children.length, 0);
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

  it('skips empty attribute values instead of writing them as attr="" (e.g. xml:id must never be empty)', () => {
    // A leaf's rendered row has one input per schema attribute regardless
    // of whether the user filled it in - writing every one of them
    // unconditionally produces invalid XML for NCName-typed attributes
    // like xml:id (the empty string is not a valid NCName) and pollutes
    // the output with meaningless empty attributes for any other one.
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><titleStmt/></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const titleStmt = dom.window.document.getElementsByTagName('titleStmt')[0];
    const tree = [{ tag: 'title', isLeaf: true, required: false, repeatable: false, attributes: [], children: [] }];
    applyFieldValues(tree, titleStmt, {
      title: [{ text: 'New title', attrs: { 'xml:id': '', type: 'main' } }]
    }, NS);
    const titleEl = titleStmt.getElementsByTagName('title')[0];
    assert.strictEqual(titleEl.hasAttribute('xml:id'), false, 'empty xml:id must not be written');
    assert.strictEqual(titleEl.getAttribute('type'), 'main', 'non-empty attributes must still be written');
  });

  it('does not delete a non-leaf element holding plain text on an untouched round-trip (regression: silent data loss)', () => {
    // publisher is non-leaf (TEI allows structured markup like orgName
    // inside it), but this document's publisher holds plain text instead
    // - a real, common case (e.g. <publisher>Nomos Verlag</publisher>).
    // readFieldValues() only looks for matching child ELEMENTS, so it
    // returns {} for publisher regardless of its real text content;
    // applyFieldValues() must not mistake that for "the user cleared this
    // section" and delete the element - confirmed (before this fix) to
    // silently delete <publisher> on ANY save that reaches publicationStmt,
    // even one that only touched an unrelated field like date.
    const dom = new JSDOM(
      `<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><publicationStmt><publisher>Nomos Verlag</publisher><date type="publication">2020</date></publicationStmt></fileDesc></teiHeader></TEI>`,
      { contentType: 'text/xml' }
    );
    const publicationStmt = dom.window.document.getElementsByTagName('publicationStmt')[0];
    const tree = [
      {
        tag: 'publisher', isLeaf: false, required: false, repeatable: false, attributes: [],
        children: [{ tag: 'orgName', isLeaf: true, required: false, repeatable: false, attributes: [], children: [] }]
      },
      { tag: 'date', isLeaf: true, required: false, repeatable: false, attributes: [], children: [] }
    ];

    // Simulates "user opened the dialog, touched nothing relevant, clicked
    // Save" - the unmodified read values are applied straight back.
    const values = readFieldValues(tree, publicationStmt);
    applyFieldValues(tree, publicationStmt, values, NS);

    const publisherEl = publicationStmt.getElementsByTagName('publisher')[0];
    assert.ok(publisherEl, 'publisher element must still exist');
    assert.strictEqual(publisherEl.textContent, 'Nomos Verlag', 'publisher text content must be unchanged');
    assert.strictEqual(publicationStmt.getElementsByTagName('date')[0].textContent, '2020');
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

  it('removes an existing non-leaf element whose values were all cleared', () => {
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><sourceDesc><biblStruct><monogr><imprint><date>2020</date></imprint></monogr></biblStruct></sourceDesc></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const monogr = dom.window.document.getElementsByTagName('monogr')[0];
    const dateLeaf = { tag: 'date', isLeaf: true, required: false, repeatable: false, attributes: [], children: [] };
    const tree = [
      { tag: 'imprint', isLeaf: false, required: false, repeatable: false, attributes: [], children: [dateLeaf] }
    ];

    assert.strictEqual(monogr.getElementsByTagName('imprint').length, 1);

    // Clearing imprint's only leaf value should remove the now-empty
    // <imprint/> element itself, not leave a dangling husk behind.
    applyFieldValues(tree, monogr, { imprint: { date: [{ text: '', attrs: {} }] } }, NS);

    assert.strictEqual(monogr.getElementsByTagName('imprint').length, 0);
  });
});

describe('getMainInput', () => {
  it('picks a row\'s main value input, not a per-attribute input that happens to be an sl-input too', () => {
    // Mirrors TeiHeaderEditorPlugin#renderLeafRow()'s output: the main
    // value input is appended first, then one sl-input/sl-select per
    // attribute (e.g. title's `type` attribute renders as a plain
    // sl-input with dataset.attr set). A required leaf with an empty
    // value but a filled-in attribute must still resolve its main input
    // as empty - this is the regression the Critical review finding was
    // about (querySelectorAll over the whole group previously matched
    // both and could be fooled by a non-empty attribute input).
    const dom = new JSDOM('<!doctype html><div id="row"></div>');
    const document = dom.window.document;
    const row = document.getElementById('row');

    const mainInput = document.createElement('sl-input');
    mainInput.value = '';
    row.appendChild(mainInput);

    const attrInput = document.createElement('sl-input');
    attrInput.dataset.attr = 'type';
    attrInput.value = 'main';
    row.appendChild(attrInput);

    const resolved = getMainInput(row);
    assert.strictEqual(resolved, mainInput);
    assert.strictEqual(resolved.value, '');
  });
});

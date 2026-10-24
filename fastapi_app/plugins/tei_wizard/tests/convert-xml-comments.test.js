/**
 * Unit tests for the convert-xml-comments enhancement
 *
 * @testCovers fastapi_app/plugins/tei_wizard/enhancements/convert-xml-comments.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { elementByPath, elementPath } from '../../../../app/src/modules/node-anchor.js';
import { readComments } from '../../../../app/src/modules/unit-comments.js';

const dom = new JSDOM();
global.window = dom.window;
global.Node = dom.window.Node;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;

const { execute, domElementPath } = await import('../enhancements/convert-xml-comments.js');

const INPUT = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>T</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body/>
    <back>
      <listBibl>
        <bibl>Alpha 2001</bibl>
        <!-- check the year -->
        <bibl>Beta 2002</bibl>
        <bibl>Gamma <!-- typo? -->2003</bibl>
      </listBibl>
    </back>
  </text>
</TEI>`;

/**
 * @param {string} text
 * @returns {Document}
 */
function parse(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

describe('convert-xml-comments enhancement', () => {
  it('moves the comments of <text> into unit comments', () => {
    const doc = parse(INPUT);
    execute(doc, { user: { username: 'jdoe', fullname: 'Jane Doe' } }, new Map());
    const out = new XMLSerializer().serializeToString(doc);
    assert.ok(!out.includes('<!--'), 'comments are removed');
    assert.ok(out.includes('<title>T</title>\n        <respStmt><persName xml:id="jdoe">Jane Doe</persName><resp>Commenter</resp></respStmt>\n      </titleStmt>'));
    // the comment on its own line takes the line with it
    assert.match(out, /<bibl>Alpha 2001<\/bibl>\n {8}<bibl>Beta 2002<\/bibl>/);
    assert.match(out, /<\/teiHeader>\n {2}<standOff>\n {4}<listAnnotation type="unit-comment" subtype="fp-sha256-8-v1">\n {6}<annotation /);
    assert.match(out, /<\/annotation>\n {4}<\/listAnnotation>\n {2}<\/standOff>\n {2}<text>/);

    const list = /** @type {Element} */ (doc.getElementsByTagName('listAnnotation')[0]);
    const comments = readComments(list);
    assert.deepStrictEqual(comments.map(c => [c.path, c.text, c.author]), [
      ['/TEI/text/back/listBibl/bibl[2]', 'check the year', 'jdoe'],
      ['/TEI/text/back/listBibl/bibl[3]', 'typo?', 'jdoe']
    ]);
    // the editor finds the elements at these paths
    const state = EditorState.create({ doc: out, extensions: [xml()] });
    const beta = /** @type {any} */ (elementByPath(state, /** @type {string} */ (comments[0]?.path)));
    assert.ok(state.doc.sliceString(beta.from, beta.to).includes('Beta'));
  });

  it('computes the same XPaths as the editor', () => {
    const doc = parse(INPUT);
    const state = EditorState.create({ doc: INPUT, extensions: [xml()] });
    const read = (/** @type {number} */ a, /** @type {number} */ b) => state.doc.sliceString(a, b);
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      const path = domElementPath(el);
      const node = elementByPath(state, path);
      assert.ok(node, path);
      assert.strictEqual(elementPath(node, read), path);
    }
  });

  it('leaves documents without comments unchanged', () => {
    const text = INPUT.replace(/<!--[^>]*-->/g, '');
    const doc = parse(text);
    execute(doc, {}, new Map());
    assert.strictEqual(new XMLSerializer().serializeToString(doc), new XMLSerializer().serializeToString(parse(text)));
  });
});

/**
 * Unit tests for the checks of navigation XPath expressions
 *
 * @testCovers app/src/modules/navigation-xpath-utils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const { document } = new JSDOM('<!DOCTYPE html>').window
const { checkNavigationXpath, namespacePrefixes, labelToText, indexAtOrAfterNode } = await import('../../../app/src/modules/navigation-xpath-utils.js')

describe('checkNavigationXpath', () => {
  it('accepts absolute expressions that select elements', () => {
    for (const xpath of ['//tei:listBibl/tei:bibl', '/tei:TEI/tei:text//tei:pb', '//tei:bibl[@type="a:b"]', '//tei:*[@xml:id]', '/descendant::tei:div']) {
      assert.strictEqual(checkNavigationXpath(xpath, document), null, xpath)
    }
  })

  it('rejects relative expressions', () => {
    assert.match(checkNavigationXpath('tei:bibl', document) ?? '', /must start with '\/'/)
  })

  it('rejects an empty expression', () => {
    assert.match(checkNavigationXpath('  ', document) ?? '', /Enter an XPath/)
  })

  it('rejects unknown namespace prefixes', () => {
    assert.match(checkNavigationXpath('//foo:bar', document) ?? '', /Unknown namespace prefix "foo"/)
  })

  it('rejects syntax errors', () => {
    assert.match(checkNavigationXpath('//tei:bibl[', document) ?? '', /Invalid XPath/)
  })

  it('rejects expressions that do not select nodes', () => {
    assert.match(checkNavigationXpath('/tei:TEI = 1', document) ?? '', /must select elements/)
  })
})

describe('namespacePrefixes', () => {
  it('ignores axes and string literals', () => {
    assert.deepStrictEqual(namespacePrefixes('/child::tei:a[@b="x:y"][\'p:q\']/xml:z'), ['tei', 'xml'])
  })
})

describe('labelToText', () => {
  it('decodes HTML entities', () => {
    assert.strictEqual(labelToText('&lt;bibl&gt; &amp; co', document), '<bibl> & co')
  })
})

describe('indexAtOrAfterNode', () => {
  const { window } = new JSDOM('')
  const xml = new window.DOMParser().parseFromString(
    '<text><front><p/></front><listBibl><bibl/><bibl/></listBibl><page/><listBibl><bibl/></listBibl><back/></text>', 'application/xml')
  const text = /** @type {Element} */ (xml.documentElement)
  const children = Array.from(text.children)
  const [front, listBibl1, page, listBibl2] = children
  const bibls = Array.from(xml.getElementsByTagName('bibl'))
  const listBibls = [listBibl1, listBibl2]

  it('stays on the current node if the new expression selects it', () => {
    assert.strictEqual(indexAtOrAfterNode(children, listBibl2), 4)
  })

  it('selects the node that contains the current node', () => {
    assert.strictEqual(indexAtOrAfterNode(listBibls, bibls[1]), 1)
    assert.strictEqual(indexAtOrAfterNode(children, bibls[2]), 4)
  })

  it('selects the innermost of several nodes that contain the current node', () => {
    assert.strictEqual(indexAtOrAfterNode([text, listBibl1, bibls[0]], bibls[1]), 2)
  })

  it('selects the first descendant or following node', () => {
    assert.strictEqual(indexAtOrAfterNode(bibls, listBibl1), 1)
    assert.strictEqual(indexAtOrAfterNode(bibls, page), 3)
    assert.strictEqual(indexAtOrAfterNode(listBibls, front), 1)
    assert.strictEqual(indexAtOrAfterNode(listBibls, page), 2)
  })

  it('wraps around to the first node when no node follows', () => {
    assert.strictEqual(indexAtOrAfterNode(bibls, children[4]), 1)
  })

  it('returns 0 without nodes', () => {
    assert.strictEqual(indexAtOrAfterNode([], page), 0)
  })
})

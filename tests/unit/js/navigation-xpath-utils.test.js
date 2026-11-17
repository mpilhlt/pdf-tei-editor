/**
 * Unit tests for the checks of navigation XPath expressions
 *
 * @testCovers app/src/modules/navigation-xpath-utils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const { document } = new JSDOM('<!DOCTYPE html>').window
const { checkNavigationXpath, namespacePrefixes, labelToText } = await import('../../../app/src/modules/navigation-xpath-utils.js')

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

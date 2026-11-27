/**
 * Unit tests for TEI utilities
 *
 * Tests TEI document manipulation functions including edition management
 * and fileref preservation.
 *
 * @testCovers app/src/modules/tei-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import {
  addEdition,
  encodeXmlEntities,
  ensureExtractorVariant,
  encodeFileIdForXmlId,
  decodeXmlIdToFileId,
  getEditorialDeclGuides,
  isInTeiText,
  getPageBreakHint,
  findPageBreak,
  getPageBreakText,
  getPdfLookupNode,
  addRevisionChange,
  recordOcrCorrections,
  describeOcrCorrections,
  getRevisionLabel,
  getRevisionStatus,
} from '../../../app/src/modules/tei-utils.js';

describe('getEditorialDeclGuides', () => {
  function parseXml(xmlString) {
    const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
    return dom.window.document;
  }

  it('returns human and machine refs for one interpretation', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref>
            <ref subtype="machine" target="https://example.com/g.md#L1-L20" type="markdown">Guide</ref>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.strictEqual(guides.length, 1);
    assert.deepStrictEqual(guides[0], {
      category: 'primary',
      refs: [
        { target: 'https://example.com/g.md#seg', contentType: 'markdown', subtype: 'human' },
        { target: 'https://example.com/g.md#L1-L20', contentType: 'markdown', subtype: 'machine' },
      ]
    });
  });

  it('returns multiple interpretations', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref subtype="machine" target="https://example.com/g.md#L120-L180" type="markdown">Footnotes</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.strictEqual(guides.length, 2);
    assert.strictEqual(guides[0].category, 'primary');
    assert.strictEqual(guides[1].category, 'footnote-annotation');
  });

  it('returns an empty array when there is no editorialDecl', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('returns contentType: null when a ref has no type attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/g.md#seg">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.deepStrictEqual(guides, [
      { category: 'primary', refs: [
        { target: 'https://example.com/g.md#seg', contentType: null, subtype: 'human' }
      ] }
    ]);
  });

  it('skips an interpretation missing its type attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation>
          <p><ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('skips an interpretation whose only ref has no target attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('skips a ref with an unrecognized subtype but keeps its sibling', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="robot" target="https://example.com/g.md#odd" type="markdown">Odd</ref>
            <ref subtype="human" target="https://example.com/g.md#seg" type="markdown">Guide</ref>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    const guides = getEditorialDeclGuides(xmlDoc);
    assert.deepStrictEqual(guides, [
      { category: 'primary', refs: [
        { target: 'https://example.com/g.md#seg', contentType: 'markdown', subtype: 'human' }
      ] }
    ]);
  });

  it('skips an interpretation whose only ref has a missing subtype attribute', () => {
    const xmlDoc = parseXml(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref target="https://example.com/g.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>`);
    assert.deepStrictEqual(getEditorialDeclGuides(xmlDoc), []);
  });

  it('throws for a plain object argument lacking getElementsByTagName', () => {
    assert.throws(() => getEditorialDeclGuides({}));
    assert.throws(() => getEditorialDeclGuides('not a document'));
  });

  it('throws for a non-XML-document argument', () => {
    assert.throws(() => getEditorialDeclGuides(null));
  });
});

describe('TEI Utils', () => {
  describe('addEdition (deprecated no-op)', () => {
    it('should not modify the document', () => {
      const xmlString = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc xml:id="_test-document-2025">
      <titleStmt><title>Test Document</title></titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>`;
      const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
      const xmlDoc = dom.window.document;
      addEdition(xmlDoc, { title: 'Version 2', note: 'Second version' });
      // addEdition is a no-op — document should be unchanged
      assert.strictEqual(xmlDoc.querySelector('editionStmt'), null, 'No editionStmt should be created');
    });
  });

  describe('encodeFileIdForXmlId / decodeXmlIdToFileId', () => {
    it('should prepend _ when file_id starts with a digit', () => {
      assert.strictEqual(encodeFileIdForXmlId('10.5771__2699-1284-2024-3-149'), '_10.5771__2699-1284-2024-3-149');
    });

    it('should not prepend _ when file_id starts with a letter', () => {
      assert.strictEqual(encodeFileIdForXmlId('my-document'), 'my-document');
    });

    it('should replace $XX$ with _xXX_', () => {
      assert.strictEqual(encodeFileIdForXmlId('doc$2F$name'), 'doc_x2F_name');
    });

    it('should round-trip: decode reverses encode (new _xXX_ format)', () => {
      const cases = [
        '10.5771__2699-1284-2024-3-149',
        'my-document',
        'path_x2F_to_x2F_doc',
        '10.1234__test_x20_value',
      ];
      for (const id of cases) {
        assert.strictEqual(decodeXmlIdToFileId(encodeFileIdForXmlId(id)), id, `Round-trip failed for: ${id}`);
      }
    });

    it('should one-way convert legacy $XX$ encoding to new _xXX_ format', () => {
      // Legacy $XX$ file_ids are converted to new format; not round-trippable
      assert.strictEqual(decodeXmlIdToFileId(encodeFileIdForXmlId('path$2F$to$2F$doc')), 'path_x2F_to_x2F_doc');
      assert.strictEqual(decodeXmlIdToFileId(encodeFileIdForXmlId('10.1234__test$20$value')), '10.1234__test_x20_value');
    });

    it('should strip leading _ only if followed by digit', () => {
      assert.strictEqual(decodeXmlIdToFileId('_10.5771__abc'), '10.5771__abc');
      assert.strictEqual(decodeXmlIdToFileId('_my-doc'), '_my-doc'); // _ before letter: keep
    });
  });


  describe('encodeXmlEntities', () => {
    it('should preserve comments with angle brackets', () => {
      const input = '<root><!-- Comment with & < > characters --><text>Content & text</text></root>';
      const expected = '<root><!-- Comment with & < > characters --><text>Content &amp; text</text></root>';
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should preserve comment with processing instruction (RNG schema case)', () => {
      const input = `<!--
To validate TEI documents against this schema, add this processing instruction
to the beginning of your TEI document (after the XML declaration):
<?xml-model href="http://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>

V1 - corrected

-->
<root>Content & text</root>`;
      const expected = `<!--
To validate TEI documents against this schema, add this processing instruction
to the beginning of your TEI document (after the XML declaration):
<?xml-model href="http://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>

V1 - corrected

-->
<root>Content &amp; text</root>`;
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should preserve CDATA sections', () => {
      const input = '<root><![CDATA[Content with & < > characters]]><text>Content & text</text></root>';
      const expected = '<root><![CDATA[Content with & < > characters]]><text>Content &amp; text</text></root>';
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should preserve processing instructions', () => {
      const input = '<?xml-stylesheet href="style.css" type="text/css"?><root>Content & text</root>';
      const expected = '<?xml-stylesheet href="style.css" type="text/css"?><root>Content &amp; text</root>';
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should handle multiple comments', () => {
      const input = '<root><!-- Comment 1 with > --><text>Content & text</text><!-- Comment 2 with < --></root>';
      const expected = '<root><!-- Comment 1 with > --><text>Content &amp; text</text><!-- Comment 2 with < --></root>';
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should encode required entities in content', () => {
      const input = '<root>Test & text</root>';
      const expected = '<root>Test &amp; text</root>';
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should preserve quotes by default', () => {
      const input = `<root>Test "quoted" and 'apostrophe' text</root>`;
      const expected = `<root>Test "quoted" and 'apostrophe' text</root>`;
      const result = encodeXmlEntities(input);
      assert.strictEqual(result, expected);
    });

    it('should encode quotes when option enabled', () => {
      const input = `<root>Test "quoted" and 'apostrophe' text</root>`;
      const expected = `<root>Test &quot;quoted&quot; and &apos;apostrophe&apos; text</root>`;
      const result = encodeXmlEntities(input, { encodeQuotes: true });
      assert.strictEqual(result, expected);
    });
  });

  describe('ensureExtractorVariant', () => {
    it('should add variant to existing appInfo with extractor application', () => {
      const xmlString = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
    </fileDesc>
    <encodingDesc>
      <appInfo>
        <application version="1.0" ident="pdf-tei-editor" type="editor">
          <label>PDF-TEI-Editor</label>
          <ref target="https://github.com/mpilhlt/pdf-tei-editor"/>
        </application>
        <application version="0.8.3-SNAPSHOT" ident="GROBID" when="2025-08-07T14:15:00.573667Z" type="extractor">
          <label>A machine learning software for extracting information from scholarly documents</label>
          <desc>GROBID - A machine learning software for extracting information from scholarly documents</desc>
          <label type="revision">e13aa19</label>
          <label type="flavor">article/dh-law-footnotes</label>
          <ref target="https://github.com/kermitt2/grobid"/>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
</TEI>`;

      const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
      const xmlDoc = dom.window.document;

      ensureExtractorVariant(xmlDoc, 'grobid.training.segmentation');

      // Check that variant-id label was added to extractor application
      const extractorApp = xmlDoc.querySelector('application[type="extractor"]');
      assert.ok(extractorApp, 'Extractor application should exist');

      const variantLabel = extractorApp.querySelector('label[type="variant-id"]');
      assert.ok(variantLabel, 'Variant-id label should exist');
      assert.strictEqual(
        variantLabel.textContent,
        'grobid.training.segmentation',
        'Variant should match'
      );

      // Check that other labels are preserved
      const revisionLabel = extractorApp.querySelector('label[type="revision"]');
      assert.ok(revisionLabel, 'Revision label should be preserved');
      assert.strictEqual(revisionLabel.textContent, 'e13aa19');

      const flavorLabel = extractorApp.querySelector('label[type="flavor"]');
      assert.ok(flavorLabel, 'Flavor label should be preserved');
      assert.strictEqual(flavorLabel.textContent, 'article/dh-law-footnotes');
    });

    it('should update existing variant-id when already present', () => {
      const xmlString = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
    </fileDesc>
    <encodingDesc>
      <appInfo>
        <application version="0.8.3-SNAPSHOT" ident="GROBID" type="extractor">
          <label>GROBID</label>
          <label type="variant-id">old-variant</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
</TEI>`;

      const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
      const xmlDoc = dom.window.document;

      ensureExtractorVariant(xmlDoc, 'grobid.training.segmentation');

      const variantLabel = xmlDoc.querySelector('label[type="variant-id"]');
      assert.ok(variantLabel, 'Variant-id label should exist');
      assert.strictEqual(
        variantLabel.textContent,
        'grobid.training.segmentation',
        'Variant should be updated'
      );

      // Should only have one variant-id label
      const variantLabels = xmlDoc.querySelectorAll('label[type="variant-id"]');
      assert.strictEqual(variantLabels.length, 1, 'Should have exactly one variant-id label');
    });

    it('should create appInfo and extractor application when missing', () => {
      const xmlString = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>`;

      const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
      const xmlDoc = dom.window.document;

      ensureExtractorVariant(xmlDoc, 'grobid.training.segmentation');

      // Check structure was created
      const encodingDesc = xmlDoc.querySelector('encodingDesc');
      assert.ok(encodingDesc, 'encodingDesc should be created');

      const appInfo = encodingDesc.querySelector('appInfo');
      assert.ok(appInfo, 'appInfo should be created');

      const extractorApp = appInfo.querySelector('application[type="extractor"]');
      assert.ok(extractorApp, 'Extractor application should be created');

      const variantLabel = extractorApp.querySelector('label[type="variant-id"]');
      assert.ok(variantLabel, 'Variant-id label should be created');
      assert.strictEqual(
        variantLabel.textContent,
        'grobid.training.segmentation',
        'Variant should match'
      );
    });

    it('should create extractor application when appInfo exists but no extractor', () => {
      const xmlString = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
    </fileDesc>
    <encodingDesc>
      <appInfo>
        <application version="1.0" ident="pdf-tei-editor" type="editor">
          <label>PDF-TEI-Editor</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
</TEI>`;

      const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
      const xmlDoc = dom.window.document;

      ensureExtractorVariant(xmlDoc, 'grobid.training.segmentation');

      // Check that extractor application was added
      const applications = xmlDoc.querySelectorAll('application');
      assert.strictEqual(applications.length, 2, 'Should have two applications');

      const extractorApp = xmlDoc.querySelector('application[type="extractor"]');
      assert.ok(extractorApp, 'Extractor application should be created');

      const variantLabel = extractorApp.querySelector('label[type="variant-id"]');
      assert.ok(variantLabel, 'Variant-id label should be created');
      assert.strictEqual(
        variantLabel.textContent,
        'grobid.training.segmentation',
        'Variant should match'
      );

      // Check that editor application is still present
      const editorApp = xmlDoc.querySelector('application[type="editor"]');
      assert.ok(editorApp, 'Editor application should be preserved');
    });
  });
});

describe('isInTeiText', () => {
  const doc = new JSDOM(
    '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader>'
    + '<text><body><p>Body <hi>text</hi></p></body></text></TEI>',
    { contentType: 'text/xml' }
  ).window.document;

  it('accepts /TEI/text and its descendants', () => {
    assert.strictEqual(isInTeiText(doc.getElementsByTagName('text')[0]), true);
    assert.strictEqual(isInTeiText(doc.getElementsByTagName('hi')[0]), true);
    assert.strictEqual(isInTeiText(doc.getElementsByTagName('hi')[0].firstChild), true);
  });

  it('rejects header nodes and the root element', () => {
    assert.strictEqual(isInTeiText(doc.getElementsByTagName('title')[0]), false);
    assert.strictEqual(isInTeiText(doc.getElementsByTagName('teiHeader')[0]), false);
    assert.strictEqual(isInTeiText(doc.documentElement), false);
  });
});

describe('document history ignores stand-off revisionDesc', () => {
  const xml = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc><titleStmt><title>T</title></titleStmt></fileDesc>
    <revisionDesc>
      <change when="2026-10-01T10:00:00Z" who="#anna" status="in-review"><note type="label">v1</note></change>
    </revisionDesc>
  </teiHeader>
  <text><body><p>x</p></body></text>
  <standOff>
    <listAnnotation type="unit-comment">
      <annotation xml:id="uc-000001" motivation="commenting" target="#xpath(/TEI/text/body/p)" resp="#ben">
        <revisionDesc>
          <change when="2026-10-24T09:30:00Z" who="#ben" status="resolved"><note type="label">stand-off</note></change>
        </revisionDesc>
        <note type="comment">ok</note>
      </annotation>
    </listAnnotation>
  </standOff>
</TEI>`;

  /** @param {string} source */
  function parse(source) {
    return new JSDOM(source, { contentType: 'text/xml' }).window.document;
  }

  it('getRevisionLabel reads the header only', () => {
    assert.strictEqual(getRevisionLabel(parse(xml)), 'v1');
  });

  it('getRevisionStatus reads the last header change only', () => {
    assert.strictEqual(getRevisionStatus(parse(xml)), 'in-review');
  });

  it('getRevisionStatus returns null without a status', () => {
    assert.strictEqual(getRevisionStatus(parse(xml.replace(' status="in-review"', ''))), null);
    assert.strictEqual(getRevisionStatus(parse(xml.replace(/<revisionDesc>\s*<change when="2026-10-01[\s\S]*?<\/revisionDesc>/, ''))), null);
  });

  it('addRevisionChange creates the header revisionDesc instead of using a stand-off one', () => {
    const doc = parse(xml.replace(/<revisionDesc>\s*<change when="2026-10-01[\s\S]*?<\/revisionDesc>/, ''));
    addRevisionChange(doc, { status: 'draft', persId: 'anna', desc: 'Edited' });
    const headerChanges = doc.querySelectorAll('teiHeader > revisionDesc > change');
    assert.strictEqual(headerChanges.length, 1);
    assert.strictEqual(headerChanges[0].getAttribute('status'), 'draft');
    assert.strictEqual(doc.querySelectorAll('standOff revisionDesc > change').length, 1);
  });
});

describe('getPdfLookupNode', () => {
  const doc = new JSDOM(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><text id="t">
  <pb n="1"/>
  <p id="p1">First page <hi id="h1">text</hi></p>
  <pb n="2"/>
  <p id="p2">Second page</p>
  <div id="d1"><p id="p3">Third</p><pb n="3"/><p id="p4">page</p></div>
</text></TEI>`, { contentType: 'text/xml' }).window.document;
  const byId = (/** @type {string} */ id) => /** @type {Element} */ (doc.querySelector(`[id="${id}"]`));

  it('returns the selected node if the cursor is inside it', () => {
    assert.strictEqual(getPdfLookupNode(byId('p1'), byId('h1')), byId('p1'));
    assert.strictEqual(getPdfLookupNode(byId('d1'), byId('d1')), byId('d1'));
  });

  it('returns the selected node if there is no cursor node', () => {
    assert.strictEqual(getPdfLookupNode(byId('p1'), null), byId('p1'));
    assert.strictEqual(getPdfLookupNode(null, null), null);
  });

  it('returns the element at the cursor if it is outside the selected node', () => {
    assert.strictEqual(getPdfLookupNode(byId('p1'), byId('p2')), byId('p2'));
    assert.strictEqual(getPdfLookupNode(null, byId('p2')), byId('p2'));
  });

  // https://github.com/mpilhlt/pdf-tei-editor/issues/900
  it('returns null for whitespace in a container of the selected node', () => {
    assert.strictEqual(getPdfLookupNode(byId('p1'), byId('t')), null);
    assert.strictEqual(getPdfLookupNode(byId('p3'), byId('d1')), null);
  });

  it('returns null for whitespace in an element containing a page break', () => {
    const pb = doc.getElementsByTagNameNS('*', 'pb')[0];
    assert.strictEqual(getPdfLookupNode(pb, byId('t')), null);
    assert.strictEqual(getPdfLookupNode(null, byId('t')), null);
    assert.strictEqual(getPdfLookupNode(null, byId('d1')), null);
  });
});

describe('getPageBreakHint', () => {
  const doc = new JSDOM(`<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><text>
  <front id="f">Title</front>
  <pb n="1"/>
  <body id="b1">First page <lb/>text</body>
  <pb n="x"/>
  <body id="b2">Second page</body>
  <body id="b3">Starts on the second page <pb n="3"/> and continues on the third</body>
  <pb/>
  <note id="n4">Fourth page</note>
</text></TEI>`, { contentType: 'text/xml' }).window.document;
  const byId = (/** @type {string} */ id) => /** @type {Element} */ (doc.querySelector(`[id="${id}"]`));
  const pbs = doc.getElementsByTagNameNS('*', 'pb');

  it('returns null for a node before the first page break', () => {
    assert.strictEqual(getPageBreakHint(byId('f')), null);
  });

  it('returns the ordinal and n of the nearest preceding page break', () => {
    assert.deepStrictEqual(getPageBreakHint(byId('b1')), { ordinal: 1, n: 1 });
    assert.deepStrictEqual(getPageBreakHint(/** @type {Node} */ (byId('b1').firstChild)), { ordinal: 1, n: 1 });
  });

  it('ignores a non-numeric or missing n', () => {
    assert.deepStrictEqual(getPageBreakHint(byId('b2')), { ordinal: 2, n: null });
    assert.deepStrictEqual(getPageBreakHint(byId('n4')), { ordinal: 4, n: null });
  });

  it('does not count page breaks inside the node', () => {
    assert.deepStrictEqual(getPageBreakHint(byId('b3')), { ordinal: 2, n: null });
  });

  it('returns the page break itself for a pb', () => {
    assert.deepStrictEqual(getPageBreakHint(pbs[2]), { ordinal: 3, n: 3 });
  });

  it('findPageBreak finds a pb by n or by ordinal', () => {
    assert.strictEqual(findPageBreak(doc, { n: 3 }), pbs[2]);
    assert.strictEqual(findPageBreak(doc, { n: 2 }), null);
    assert.strictEqual(findPageBreak(doc, { ordinal: 4 }), pbs[3]);
    assert.strictEqual(findPageBreak(doc, { ordinal: 5 }), null);
  });

  it('getPageBreakText returns the text up to the next pb', () => {
    assert.strictEqual(getPageBreakText(pbs[0]), 'First page text');
    assert.strictEqual(getPageBreakText(pbs[1]), 'Second page Starts on the second page');
    assert.strictEqual(getPageBreakText(pbs[3]), 'Fourth page');
    assert.strictEqual(getPageBreakText(pbs[1], 6), 'Second');
  });
});

describe('recordOcrCorrections', () => {
  const parse = (header) => new JSDOM(`<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader>${header}</teiHeader><text/></TEI>`, { contentType: 'text/xml' }).window.document;
  const changes = (doc) => Array.from(doc.querySelectorAll('teiHeader > revisionDesc > change'));

  it('adds a change by the user without a label', () => {
    const doc = parse('<revisionDesc><change when="2026-01-01" status="extraction"><note type="label">Extraction</note><desc>Extracted</desc></change></revisionDesc>');
    const record = recordOcrCorrections(doc, { persId: 'rev', status: 'draft', models: ['Model A'] });
    const all = changes(doc);
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[1].getAttribute('who'), '#rev');
    assert.strictEqual(all[1].getAttribute('status'), 'draft');
    assert.strictEqual(all[1].getAttribute('when'), record.when);
    assert.strictEqual(all[1].querySelector('desc').textContent, 'Accepted 1 OCR correction suggested by Model A');
    // the version label stays
    assert.strictEqual(getRevisionLabel(doc), 'Extraction');
  });

  it('updates the change while it is the last one', () => {
    const doc = parse('');
    let record = recordOcrCorrections(doc, { persId: 'rev', status: 'draft', models: ['Model A'] });
    record = recordOcrCorrections(doc, { persId: 'rev', status: 'draft', models: ['Model B'], previous: record });
    record = recordOcrCorrections(doc, { persId: 'rev', status: 'draft', count: 2, models: ['Model A', null], previous: record });
    assert.strictEqual(changes(doc).length, 1);
    assert.deepStrictEqual([record.count, record.models], [4, ['Model A', 'Model B']]);
    assert.strictEqual(changes(doc)[0].querySelector('desc').textContent, 'Accepted 4 OCR corrections suggested by Model A, Model B');
  });

  it('adds a new change after another change', () => {
    const doc = parse('');
    const record = recordOcrCorrections(doc, { persId: 'rev', status: 'draft', models: ['Model A'] });
    addRevisionChange(doc, { persId: 'rev', desc: 'Renamed to X', label: 'X' });
    changes(doc)[1].setAttribute('when', 'later');
    recordOcrCorrections(doc, { persId: 'rev', status: 'draft', previous: record });
    assert.strictEqual(changes(doc).length, 3);
    // the new change records only the corrections accepted after the other change
    assert.strictEqual(changes(doc)[2].querySelector('desc').textContent, 'Accepted 1 OCR correction suggested by a language model');
  });

  it('describes the corrections', () => {
    assert.strictEqual(describeOcrCorrections({ when: '', count: 2, models: [] }), 'Accepted 2 OCR corrections suggested by a language model');
  });
});

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
} from '../../../app/src/modules/tei-utils.js';

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

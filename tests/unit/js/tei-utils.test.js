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
import { addEdition, encodeXmlEntities, ensureExtractorVariant } from '../../../app/src/modules/tei-utils.js';

describe('TEI Utils', () => {
  describe('addEdition', () => {
    it('should preserve fileref when adding new edition', () => {
      // Create a minimal TEI document with fileref
      const xmlString = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <date when="2025-01-01T00:00:00.000Z">01.01.2025 00:00:00</date>
          <title>Original Edition</title>
          <idno type="fileref">test-document-2025</idno>
        </edition>
      </editionStmt>
    </fileDesc>
  </teiHeader>
</TEI>`;

      const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
      const xmlDoc = dom.window.document;

      // Add a new edition
      const newEdition = {
        title: 'Version 2',
        note: 'Second version'
      };

      addEdition(xmlDoc, newEdition);

      // Check that fileref was preserved
      const filerefElements = xmlDoc.querySelectorAll('idno[type="fileref"]');
      assert.strictEqual(filerefElements.length, 1, 'Should have exactly one fileref element');
      assert.strictEqual(
        filerefElements[0].textContent,
        'test-document-2025',
        'Fileref value should be preserved'
      );

      // Check that new edition info was added
      const titleElements = xmlDoc.querySelectorAll('edition > title');
      assert.strictEqual(titleElements.length, 1, 'Should have one title element');
      assert.strictEqual(
        titleElements[0].textContent,
        'Version 2',
        'New edition title should be present'
      );

      const noteElements = xmlDoc.querySelectorAll('edition > note');
      assert.strictEqual(noteElements.length, 1, 'Should have one note element');
      assert.strictEqual(
        noteElements[0].textContent,
        'Second version',
        'New edition note should be present'
      );
    });

    it('should not add fileref when it does not exist', () => {
      // Create a minimal TEI document without fileref
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

      // Add a new edition
      const newEdition = {
        title: 'Version 1'
      };

      addEdition(xmlDoc, newEdition);

      // Check that no fileref was added
      const filerefElements = xmlDoc.querySelectorAll('idno[type="fileref"]');
      assert.strictEqual(filerefElements.length, 0, 'Should not add fileref when it did not exist');
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

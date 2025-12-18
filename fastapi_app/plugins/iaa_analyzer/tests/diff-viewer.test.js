/**
 * Unit tests for IAA diff viewer
 *
 * Tests the diff calculation logic for both "all differences" mode (which works)
 * and "semantic differences" mode (which currently doesn't work correctly).
 *
 * @testCovers fastapi_app/plugins/iaa_analyzer/diff-viewer.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Import the diff viewer module and Diff library
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffLines } from 'diff';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load and execute the diff viewer script
const diffViewerPath = join(__dirname, '../diff-viewer.js');
const diffViewerCode = readFileSync(diffViewerPath, 'utf-8');

// Create exports object
const exports = {};

// Set up global Diff object with real diff library
global.Diff = { diffLines };

// Execute the code in a context with exports
eval(diffViewerCode);

const { computeDiffBlocks, regroupByOriginalLines } = exports;

describe('IAA Diff Viewer', () => {
    describe('All Differences Mode (WORKING)', () => {
        it('should detect simple text changes', () => {
            const xml1Original = '<text>\n<p>Hello world</p>\n</text>';
            const xml2Original = '<text>\n<p>Hello universe</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed: xml1Original,
                xml2Preprocessed: xml2Original,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.ok(diffBlocks.length > 0, 'Should have diff blocks');
            assert.ok(diffBlocks[0].left.length > 0, 'Should have left side differences');
            assert.ok(diffBlocks[0].right.length > 0, 'Should have right side differences');

            // Verify line numbers are correct
            assert.strictEqual(diffBlocks[0].left[0].number, 2, 'Left line number should be 2');
            assert.strictEqual(diffBlocks[0].right[0].number, 2, 'Right line number should be 2');

            // Verify content
            assert.strictEqual(diffBlocks[0].left[0].content, '<p>Hello world</p>');
            assert.strictEqual(diffBlocks[0].right[0].content, '<p>Hello universe</p>');
        });

        it('should detect attribute changes', () => {
            const xml1Original = '<text>\n<p id="p1">Text</p>\n</text>';
            const xml2Original = '<text>\n<p id="p2">Text</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed: xml1Original,
                xml2Preprocessed: xml2Original,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.ok(diffBlocks.length > 0);
            assert.ok(diffBlocks[0].left[0].content.includes('id="p1"'));
            assert.ok(diffBlocks[0].right[0].content.includes('id="p2"'));
        });

        it('should handle multi-line differences', () => {
            const xml1Original = '<text>\n<p>Line 1</p>\n<p>Line 2</p>\n</text>';
            const xml2Original = '<text>\n<p>Line 1 modified</p>\n<p>Line 2 modified</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed: xml1Original,
                xml2Preprocessed: xml2Original,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.ok(diffBlocks.length > 0);
            // With real diff library, should have equal removed and added lines
            const totalLeft = diffBlocks.reduce((sum, block) => sum + block.left.length, 0);
            const totalRight = diffBlocks.reduce((sum, block) => sum + block.right.length, 0);
            assert.strictEqual(totalLeft, 2, 'Should have 2 removed lines');
            assert.strictEqual(totalRight, 2, 'Should have 2 added lines');
        });

        it('should respect line offsets', () => {
            const xml1Original = '<p>Test</p>';
            const xml2Original = '<p>Modified</p>';

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed: xml1Original,
                xml2Preprocessed: xml2Original,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 10,  // Content starts at line 10
                lineOffset2: 15,  // Content starts at line 15
                useSemanticMode: false
            });

            assert.strictEqual(diffBlocks[0].startLine1, 10);
            assert.strictEqual(diffBlocks[0].startLine2, 15);
            assert.strictEqual(diffBlocks[0].left[0].number, 10);
            assert.strictEqual(diffBlocks[0].right[0].number, 15);
        });
    });

    describe('Semantic Differences Mode', () => {
        it('should ignore configured attributes when diffing but show original content', () => {
            // Original XML with xml:id attributes
            const xml1Original = '<text>\n<p xml:id="p1">Hello</p>\n</text>';
            const xml2Original = '<text>\n<p xml:id="p2">Hello</p>\n</text>';

            // Preprocessed XML with xml:id removed
            const xml1Preprocessed = '<text>\n<p>Hello</p>\n</text>';
            const xml2Preprocessed = '<text>\n<p>Hello</p>\n</text>';

            // Line mapping: preprocessed line -> original line
            const lineMapping1 = { 1: 1, 2: 2, 3: 3 };
            const lineMapping2 = { 1: 1, 2: 2, 3: 3 };

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1,
                lineMapping2,
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            // No differences because preprocessed XML is identical
            assert.strictEqual(diffBlocks.length, 0);
        });

        it('should show semantic differences with preprocessed content', () => {
            // Original XML with xml:id that differs
            const xml1Original = '<text>\n<p xml:id="p1">Different</p>\n</text>';
            const xml2Original = '<text>\n<p xml:id="p2">Text</p>\n</text>';

            // Preprocessed XML with xml:id removed but text difference remains
            const xml1Preprocessed = '<text>\n<p>Different</p>\n</text>';
            const xml2Preprocessed = '<text>\n<p>Text</p>\n</text>';

            const lineMapping1 = {};
            const lineMapping2 = {};

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1,
                lineMapping2,
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            // Should find 1 diff block
            assert.strictEqual(diffBlocks.length, 1);

            // Content should be from PREPROCESSED XML (without xml:id)
            assert.strictEqual(diffBlocks[0].left[0].content, '<p>Different</p>');
            assert.strictEqual(diffBlocks[0].right[0].content, '<p>Text</p>');

            // Semantic mode doesn't show line numbers (empty string)
            assert.strictEqual(diffBlocks[0].left[0].number, '');
            assert.strictEqual(diffBlocks[0].right[0].number, '');
        });

        it('should handle line mapping when preprocessed XML has fewer lines', () => {
            // Original XML with ignored elements that span multiple lines
            const xml1Original = '<text>\n<pb n="1"/>\n<p>Text</p>\n</text>';
            const xml2Original = '<text>\n<pb n="2"/>\n<p>Text</p>\n</text>';

            // Preprocessed XML with <pb> removed (assuming <pb> is in IGNORE_TAGS)
            const xml1Preprocessed = '<text>\n<p>Text</p>\n</text>';
            const xml2Preprocessed = '<text>\n<p>Text</p>\n</text>';

            // Line mapping: preprocessed line 1 -> original line 1, preprocessed line 2 -> original line 3
            const lineMapping1 = { 1: 1, 2: 3, 3: 4 };
            const lineMapping2 = { 1: 1, 2: 3, 3: 4 };

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1,
                lineMapping2,
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            // No differences (preprocessed XML is identical)
            assert.strictEqual(diffBlocks.length, 0);
        });

        it('should handle realistic TEI with multiple ignored attributes and tags', () => {
            // Realistic TEI with multiple attributes that might be ignored
            const xml1Original = `<text>
<body xml:id="body1">
<pb n="1" facs="page1.jpg"/>
<div type="chapter">
<head rendition="bold">Chapter 1</head>
<p xml:id="p1">First paragraph with <persName type="person">John</persName>.</p>
</div>
</body>
</text>`;

            const xml2Original = `<text>
<body xml:id="body2">
<pb n="1" facs="page1.jpg"/>
<div type="chapter">
<head rendition="italic">Chapter 1</head>
<p xml:id="p2">First paragraph with <persName type="person">John</persName>.</p>
</div>
</body>
</text>`;

            // Preprocessed: xml:id removed, rendition removed, pb removed
            const xml1Preprocessed = `<text>
<body>
<div type="chapter">
<head>Chapter 1</head>
<p>First paragraph with <persName type="person">John</persName>.</p>
</div>
</body>
</text>`;

            const xml2Preprocessed = `<text>
<body>
<div type="chapter">
<head>Chapter 1</head>
<p>First paragraph with <persName type="person">John</persName>.</p>
</div>
</body>
</text>`;

            // Line mapping accounts for removed pb line
            const lineMapping1 = { 1: 1, 2: 2, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9 };
            const lineMapping2 = { 1: 1, 2: 2, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9 };

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1,
                lineMapping2,
                lineOffset1: 10,
                lineOffset2: 10,
                useSemanticMode: true
            });

            // No semantic differences (preprocessed XML is identical despite different xml:id and rendition)
            assert.strictEqual(diffBlocks.length, 0);
        });

        it('should detect semantic difference in nested elements', () => {
            const xml1Original = `<text>
<body xml:id="body1">
<pb n="1"/>
<p>Text with <persName type="person">Alice</persName> here.</p>
</body>
</text>`;

            const xml2Original = `<text>
<body xml:id="body2">
<pb n="1"/>
<p>Text with <persName type="location">Alice</persName> here.</p>
</body>
</text>`;

            // Preprocessed: xml:id removed, pb removed, but type difference remains
            const xml1Preprocessed = `<text>
<body>
<p>Text with <persName type="person">Alice</persName> here.</p>
</body>
</text>`;

            const xml2Preprocessed = `<text>
<body>
<p>Text with <persName type="location">Alice</persName> here.</p>
</body>
</text>`;

            const lineMapping1 = {};
            const lineMapping2 = {};

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1,
                lineMapping2,
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            // Should find semantic difference (type attribute changed)
            assert.strictEqual(diffBlocks.length, 1);

            // Should show preprocessed content (no xml:id, no pb)
            assert.ok(diffBlocks[0].left[0].content.includes('type="person"'));
            assert.ok(diffBlocks[0].right[0].content.includes('type="location"'));
            assert.ok(!diffBlocks[0].left[0].content.includes('xml:id'));
            assert.ok(!diffBlocks[0].right[0].content.includes('xml:id'));
        });

        it('should not show false differences when only data-line attributes differ', () => {
            // This is the core bug: identical content with different line numbers
            // should NOT create diff blocks
            const xml1Preprocessed = '<text data-line="10">\n<p data-line="11">Same content</p>\n</text>';
            const xml2Preprocessed = '<text data-line="20">\n<p data-line="21">Same content</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original: '',  // Not used in semantic mode
                xml2Original: '',
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            // Should have NO differences because content is identical
            // (only data-line values differ)
            assert.strictEqual(diffBlocks.length, 0, 'Should not show differences for identical content with different line numbers');
        });

        it('should detect real differences even with line markers', () => {
            // Real content differences should still be detected
            const xml1Preprocessed = '<text data-line="10">\n<p data-line="11">Different content</p>\n</text>';
            const xml2Preprocessed = '<text data-line="20">\n<p data-line="21">Other content</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original: '',
                xml2Original: '',
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            // Should have differences because content differs
            assert.ok(diffBlocks.length > 0, 'Should detect real content differences');
            assert.ok(diffBlocks[0].left[0].content.includes('Different content'));
            assert.ok(diffBlocks[0].right[0].content.includes('Other content'));
        });

        it('should extract line markers and enable click navigation in semantic mode', () => {
            // Preprocessed XML with data-line attributes injected
            const xml1Preprocessed = '<text data-line="1">\n<p data-line="2">Different</p>\n</text>';
            const xml2Preprocessed = '<text data-line="1">\n<p data-line="2">Text</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original: '',  // Not used in semantic mode
                xml2Original: '',  // Not used in semantic mode
                xml1Preprocessed,
                xml2Preprocessed,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: true
            });

            assert.strictEqual(diffBlocks.length, 1);

            // Content should have data-line markers stripped for display
            assert.ok(!diffBlocks[0].left[0].content.includes('data-line'));
            assert.ok(!diffBlocks[0].right[0].content.includes('data-line'));

            // Original line numbers should be extracted
            assert.strictEqual(diffBlocks[0].left[0].originalLine, 2);
            assert.strictEqual(diffBlocks[0].right[0].originalLine, 2);

            // Display line numbers should be empty in semantic mode
            assert.strictEqual(diffBlocks[0].left[0].number, '');
            assert.strictEqual(diffBlocks[0].right[0].number, '');
        });

        it('should regroup diff blocks by original line numbers', () => {
            // Simulate a diff block with mixed line numbers (as would happen with restructured XML)
            const mixedBlock = {
                left: [
                    { number: '', content: '<note place="footnote">Text 1</note>', originalLine: 100, type: 'removed' },
                    { number: '', content: '<note place="footnote">Text 2</note>', originalLine: 200, type: 'removed' },
                    { number: '', content: '<note place="footnote">Text 3</note>', originalLine: 100, type: 'removed' },
                ],
                right: [
                    { number: '', content: '<note place="headnote">Text 1</note>', originalLine: 100, type: 'added' },
                    { number: '', content: '<note place="headnote">Text 2</note>', originalLine: 200, type: 'added' },
                    { number: '', content: '<note place="headnote">Text 3</note>', originalLine: 100, type: 'added' },
                ],
                startLine1: '',
                startLine2: '',
                closed: true
            };

            const regrouped = regroupByOriginalLines([mixedBlock]);

            // Should create 2 blocks: one for line 100, one for line 200
            assert.strictEqual(regrouped.length, 2);

            // First block should have items from line 100 (2 left, 2 right)
            assert.strictEqual(regrouped[0].left.length, 2);
            assert.strictEqual(regrouped[0].right.length, 2);
            assert.strictEqual(regrouped[0].left[0].originalLine, 100);
            assert.strictEqual(regrouped[0].right[0].originalLine, 100);

            // Second block should have items from line 200 (1 left, 1 right)
            assert.strictEqual(regrouped[1].left.length, 1);
            assert.strictEqual(regrouped[1].right.length, 1);
            assert.strictEqual(regrouped[1].left[0].originalLine, 200);
            assert.strictEqual(regrouped[1].right[0].originalLine, 200);
        });
    });

    describe('Edge Cases', () => {
        it('should handle identical documents', () => {
            const xml = '<text>\n<p>Same</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original: xml,
                xml2Original: xml,
                xml1Preprocessed: xml,
                xml2Preprocessed: xml,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.strictEqual(diffBlocks.length, 0);
        });

        it('should handle empty documents', () => {
            const diffBlocks = computeDiffBlocks({
                xml1Original: '',
                xml2Original: '',
                xml1Preprocessed: '',
                xml2Preprocessed: '',
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.strictEqual(diffBlocks.length, 0);
        });

        it('should handle documents with only additions', () => {
            const xml1Original = '<text>\n<p>Line 1</p>\n</text>';
            const xml2Original = '<text>\n<p>Line 1</p>\n<p>Line 2</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed: xml1Original,
                xml2Preprocessed: xml2Original,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.ok(diffBlocks.length > 0);
            // With real diff library, should only have additions
            const totalLeft = diffBlocks.reduce((sum, block) => sum + block.left.length, 0);
            const totalRight = diffBlocks.reduce((sum, block) => sum + block.right.length, 0);
            assert.strictEqual(totalLeft, 0, 'Should have no removals');
            assert.ok(totalRight > 0, 'Should have additions');
        });

        it('should handle documents with only removals', () => {
            const xml1Original = '<text>\n<p>Line 1</p>\n<p>Line 2</p>\n</text>';
            const xml2Original = '<text>\n<p>Line 1</p>\n</text>';

            const diffBlocks = computeDiffBlocks({
                xml1Original,
                xml2Original,
                xml1Preprocessed: xml1Original,
                xml2Preprocessed: xml2Original,
                lineMapping1: {},
                lineMapping2: {},
                lineOffset1: 1,
                lineOffset2: 1,
                useSemanticMode: false
            });

            assert.ok(diffBlocks.length > 0);
            assert.ok(diffBlocks[0].left.length > 0); // Has removals
            assert.strictEqual(diffBlocks[0].right.length, 0); // No additions
        });
    });
});

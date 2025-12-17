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

// Import the diff viewer module
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load and execute the diff viewer script
const diffViewerPath = join(__dirname, '../diff-viewer.js');
const diffViewerCode = readFileSync(diffViewerPath, 'utf-8');

// Create exports object
const exports = {};

// Execute the code in a context with exports
eval(diffViewerCode);

const { computeDiffBlocks } = exports;

// Mock the Diff library
global.Diff = {
    diffLines: (text1, text2) => {
        const lines1 = text1.split('\n');
        const lines2 = text2.split('\n');
        const result = [];

        let i = 0, j = 0;
        while (i < lines1.length || j < lines2.length) {
            if (i < lines1.length && j < lines2.length && lines1[i] === lines2[j]) {
                // Common line
                let commonLines = '';
                while (i < lines1.length && j < lines2.length && lines1[i] === lines2[j]) {
                    commonLines += lines1[i] + '\n';
                    i++;
                    j++;
                }
                result.push({ value: commonLines });
            } else {
                // Different lines
                if (i < lines1.length) {
                    let removedLines = '';
                    const startI = i;
                    while (i < lines1.length && (j >= lines2.length || lines1[i] !== lines2[j])) {
                        removedLines += lines1[i] + '\n';
                        i++;
                        // Only advance if we find a match or run out
                        if (j < lines2.length) {
                            let found = false;
                            for (let k = j; k < Math.min(j + 3, lines2.length); k++) {
                                if (lines1[i - 1] === lines2[k]) {
                                    found = true;
                                    break;
                                }
                            }
                            if (found) break;
                        }
                    }
                    if (removedLines) {
                        result.push({ value: removedLines, removed: true });
                    }
                }

                if (j < lines2.length) {
                    let addedLines = '';
                    while (j < lines2.length && (i >= lines1.length || lines1[i] !== lines2[j])) {
                        addedLines += lines2[j] + '\n';
                        j++;
                        // Only advance if we find a match or run out
                        if (i < lines1.length) {
                            let found = false;
                            for (let k = i; k < Math.min(i + 3, lines1.length); k++) {
                                if (lines2[j - 1] === lines1[k]) {
                                    found = true;
                                    break;
                                }
                            }
                            if (found) break;
                        }
                    }
                    if (addedLines) {
                        result.push({ value: addedLines, added: true });
                    }
                }
            }
        }

        return result;
    }
};

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
            assert.strictEqual(diffBlocks[0].left.length, 2);
            assert.strictEqual(diffBlocks[0].right.length, 2);
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

    describe('Semantic Differences Mode (NOT WORKING)', () => {
        /**
         * EXPECTATION: Semantic mode should diff preprocessed XML (with ignored attributes removed)
         * but display content and line numbers from the original XML.
         *
         * CURRENT BEHAVIOR: The line mapping doesn't work correctly, resulting in:
         * 1. Mismatched content between left and right sides
         * 2. Wrong line numbers
         * 3. Empty or missing content
         */

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

            // EXPECTED: No differences because preprocessed XML is identical
            assert.strictEqual(diffBlocks.length, 0);

            // ACTUAL: May show differences or incorrect content
            // This test documents the expected behavior
        });

        it('should show semantic differences with correct original line numbers', () => {
            // Original XML with xml:id that differs
            const xml1Original = '<text>\n<p xml:id="p1">Different</p>\n</text>';
            const xml2Original = '<text>\n<p xml:id="p2">Text</p>\n</text>';

            // Preprocessed XML with xml:id removed but text difference remains
            const xml1Preprocessed = '<text>\n<p>Different</p>\n</text>';
            const xml2Preprocessed = '<text>\n<p>Text</p>\n</text>';

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

            // EXPECTED: Should find 1 diff block
            assert.strictEqual(diffBlocks.length, 1);

            // EXPECTED: Content should be from ORIGINAL XML (with xml:id)
            assert.strictEqual(diffBlocks[0].left[0].content, '<p xml:id="p1">Different</p>');
            assert.strictEqual(diffBlocks[0].right[0].content, '<p xml:id="p2">Text</p>');

            // EXPECTED: Line numbers should match original document
            assert.strictEqual(diffBlocks[0].left[0].number, 2);
            assert.strictEqual(diffBlocks[0].right[0].number, 2);

            // ACTUAL: May show wrong content or line numbers
            // This test documents the expected behavior
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

            // EXPECTED: No differences (preprocessed XML is identical)
            assert.strictEqual(diffBlocks.length, 0);

            // ACTUAL: May incorrectly show differences or wrong line mappings
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
            assert.strictEqual(diffBlocks[0].left.length, 0); // No removals
            assert.ok(diffBlocks[0].right.length > 0); // Has additions
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

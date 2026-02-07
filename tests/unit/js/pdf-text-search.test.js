/**
 * Tests for pdf-text-search module
 * Run with: node tests/unit-test-runner.js tests/unit/js/pdf-text-search.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import * as pdfTextSearch from '../../../app/src/modules/pdf-text-search.js';

/**
 * Creates a mock text layer with spans positioned at specific locations.
 * Simulates PDF.js text layer structure.
 * @param {Array<{text: string, left: number, top: number, width?: number, height?: number}>} spans
 * @returns {HTMLElement}
 */
function createMockTextLayer(spans) {
  const dom = new JSDOM('<!DOCTYPE html><div class="textLayer"></div>');
  const textLayer = dom.window.document.querySelector('.textLayer');

  // Set textLayer dimensions
  textLayer.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800
  });

  for (const spanData of spans) {
    const span = dom.window.document.createElement('span');
    span.textContent = spanData.text;

    const left = spanData.left;
    const top = spanData.top;
    const width = spanData.width || spanData.text.length * 6; // ~6px per char
    const height = spanData.height || 12;

    span.getBoundingClientRect = () => ({
      left, top, right: left + width, bottom: top + height, width, height
    });

    textLayer.appendChild(span);
  }

  return textLayer;
}

/**
 * Creates a mock footnotes section like in the problematic PDF.
 * Footnotes 1-7 in a narrow column, each starting with its number.
 */
function createFootnotesTextLayer() {
  const lineHeight = 11;
  const columnLeft = 400; // Right column for footnotes
  const startTop = 100;

  const spans = [];
  let currentTop = startTop;

  // Footnote 1 (2 lines)
  spans.push({ text: '1 Der vorliegende Aufsatz', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'stellt das Resultat eines', left: columnLeft, top: currentTop });
  currentTop += lineHeight * 1.5; // Gap before next footnote

  // Footnote 2 (6 lines) - THIS IS WHAT WE WANT TO FIND
  spans.push({ text: '2 Vgl. zur Nomenklatur', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'BAUER, Repertorium', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'und JOACHIM VON SCHWARZKOPF,', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'Ueber Staats- und Adress-Calen-', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'der. Ein Beytrag zur Staatenkunde,', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'Berlin 1792, 1-4.', left: columnLeft, top: currentTop });
  currentTop += lineHeight * 1.5;

  // Footnote 3 (2 lines)
  spans.push({ text: '3 SCHWARZKOPF, Staats- und Ad-', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'ress-Calender (wie Fn. 2) 24 f.', left: columnLeft, top: currentTop });
  currentTop += lineHeight * 1.5;

  // Footnote 4 (5 lines)
  spans.push({ text: '4 Vgl. zum Forschungsstand BAUER,', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'Repertorium (wie Fn. 1) Bd. 1,', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: '6-16 und CHRISTOPH WEBER,', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'Die ältesten päpstlichen Staats-', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'handbücher.', left: columnLeft, top: currentTop });
  currentTop += lineHeight * 1.5;

  // Footnote 5 (3 lines)
  spans.push({ text: '5 Vgl. neben der erwähnten Mono-', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'graphie v.a. folgende Aufsätze:', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'JOACHIM VON SCHWARZKOPF,', left: columnLeft, top: currentTop });
  currentTop += lineHeight * 1.5;

  // Footnote 6 (2 lines)
  spans.push({ text: '6 MARTIN HASS, Die preußischen', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'Adreßkalender und Staatshand-', left: columnLeft, top: currentTop });
  currentTop += lineHeight * 1.5;

  // Footnote 7 (2 lines)
  spans.push({ text: '7 Zu nennen ist hier insbesondere', left: columnLeft, top: currentTop });
  currentTop += lineHeight;
  spans.push({ text: 'JOHANNES BAUERMANN, Hof-,', left: columnLeft, top: currentTop });

  // Also add some main text spans (left column) with common words
  // These should NOT be matched when searching for footnote content
  spans.push({ text: 'Die Geschichte der', left: 50, top: 100 });
  spans.push({ text: 'und weitere Entwicklung', left: 50, top: 111 });
  spans.push({ text: 'Staats- und Verwaltung', left: 50, top: 122 });
  spans.push({ text: 'Berlin 1990.', left: 50, top: 133 });

  return createMockTextLayer(spans);
}

describe('pdf-text-search', () => {

  describe('findBestCluster - current behavior', () => {

    test('demonstrates the problem: merges all footnotes into one cluster', () => {
      const textLayer = createFootnotesTextLayer();
      const terms = ['2', 'Staats-', 'und', 'Berlin']; // Common terms appearing in multiple footnotes

      const cluster = pdfTextSearch.findBestCluster(textLayer, terms, {
        minClusterSize: 2,
        anchorTerm: '2'
      });

      console.log('Cluster span count:', cluster?.spans.length);

      // This demonstrates the problem: with loose thresholds, everything merges
      // The current algorithm can't isolate a single footnote
      assert.ok(cluster, 'Should find a cluster');
    });

  });

  describe('traceFootnoteFromAnchor - new approach', () => {

    test('should trace footnote 2 starting from anchor span', () => {
      const textLayer = createFootnotesTextLayer();
      const terms = ['2', 'Vgl.', 'zur', 'Nomenklatur', 'BAUER', 'Repertorium'];

      const result = pdfTextSearch.traceFootnoteFromAnchor(textLayer, terms, '2');

      console.log('Traced footnote:', result ? {
        spanCount: result.spans.length,
        texts: result.spans.map(s => s.span.textContent)
      } : null);

      assert.ok(result, 'Should find the footnote');
      assert.ok(result.spans.length >= 4, 'Footnote 2 should have at least 4 spans');
      assert.ok(result.spans.length <= 8, 'Should NOT include other footnotes (max 8 spans)');

      // First span should be the anchor
      assert.match(result.spans[0].span.textContent, /^2 /, 'First span should start with "2 "');
    });

    test('should stop at next footnote number', () => {
      const textLayer = createFootnotesTextLayer();
      const terms = ['2', 'Vgl.', 'BAUER'];

      const result = pdfTextSearch.traceFootnoteFromAnchor(textLayer, terms, '2');

      assert.ok(result, 'Should find the footnote');

      // Should NOT include spans from footnote 3
      const texts = result.spans.map(s => s.span.textContent);
      const hasNextFootnote = texts.some(t => t.startsWith('3 '));
      assert.ok(!hasNextFootnote, 'Should not include footnote 3');
    });

    test('should find footnote 4', () => {
      const textLayer = createFootnotesTextLayer();
      const terms = ['4', 'Forschungsstand', 'BAUER', 'WEBER', 'päpstlichen'];

      const result = pdfTextSearch.traceFootnoteFromAnchor(textLayer, terms, '4');

      console.log('Footnote 4:', result ? {
        spanCount: result.spans.length,
        texts: result.spans.map(s => s.span.textContent)
      } : null);

      assert.ok(result, 'Should find footnote 4');
      assert.match(result.spans[0].span.textContent, /^4 /, 'First span should start with "4 "');

      // Should NOT include footnote 5
      const texts = result.spans.map(s => s.span.textContent);
      const hasNextFootnote = texts.some(t => t.startsWith('5 '));
      assert.ok(!hasNextFootnote, 'Should not include footnote 5');
    });

    test('should pick best candidate when multiple anchors exist', () => {
      // Create a text layer with "6 " appearing in both main text and footnotes
      const dom = new JSDOM('<!DOCTYPE html><div class="textLayer"></div>');
      const textLayer = dom.window.document.querySelector('.textLayer');
      textLayer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 });

      const lineHeight = 11;
      const spans = [
        // Main text - has "6 items" which starts with "6 " but wrong context
        { text: '6 items were found', left: 50, top: 100 },
        { text: 'in the collection.', left: 50, top: 111 },

        // Footnote section - the real footnote 6
        { text: '6 MARTIN HASS, Die preußischen', left: 400, top: 300 },
        { text: 'Adreßkalender und Staatshand-', left: 400, top: 311 },
        { text: 'bücher als historisch-statistische', left: 400, top: 322 },
        { text: 'Quellen', left: 400, top: 333 },
      ];

      for (const spanData of spans) {
        const span = dom.window.document.createElement('span');
        span.textContent = spanData.text;
        const width = spanData.text.length * 6;
        span.getBoundingClientRect = () => ({
          left: spanData.left, top: spanData.top,
          right: spanData.left + width, bottom: spanData.top + lineHeight,
          width, height: lineHeight
        });
        textLayer.appendChild(span);
      }

      // Search for footnote 6 content - should match footnotes section, not main text
      const terms = ['6', 'MARTIN', 'HASS', 'preußischen', 'Adreßkalender'];
      const result = pdfTextSearch.traceFootnoteFromAnchor(textLayer, terms, '6');

      console.log('Multiple candidates result:', result ? {
        spanCount: result.spans.length,
        score: result.totalScore,
        firstSpan: result.spans[0].span.textContent
      } : null);

      assert.ok(result, 'Should find a result');
      // Should pick the footnotes section (higher score) not main text
      assert.match(result.spans[0].span.textContent, /MARTIN HASS/, 'Should pick footnote 6, not "6 items"');
      assert.ok(result.totalScore >= 10, 'Score should be high (matching search terms)');
    });

    test('should handle standalone anchor numbers (separate spans for number and content)', () => {
      // PDF renders "6" and "MARTIN HASS..." as separate spans
      const dom = new JSDOM('<!DOCTYPE html><div class="textLayer"></div>');
      const textLayer = dom.window.document.querySelector('.textLayer');
      textLayer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 800, width: 500, height: 800 });

      const lineHeight = 11;
      const spans = [
        // Main text with standalone "6" (like a page number or section number)
        { text: '6', left: 50, top: 50, width: 8 },
        { text: 'Some unrelated text here', left: 70, top: 50 },

        // Footnote section - "6" as separate span followed by content
        { text: '6', left: 400, top: 300, width: 8 },  // Standalone footnote number
        { text: 'MARTIN HASS, Die preußischen', left: 412, top: 300 },  // Content starts right after
        { text: 'Adreßkalender und Staatshand-', left: 400, top: 311 },
        { text: 'bücher', left: 400, top: 322 },
      ];

      for (const spanData of spans) {
        const span = dom.window.document.createElement('span');
        span.textContent = spanData.text;
        const width = spanData.width || spanData.text.length * 6;
        span.getBoundingClientRect = () => ({
          left: spanData.left, top: spanData.top,
          right: spanData.left + width, bottom: spanData.top + lineHeight,
          width, height: lineHeight
        });
        textLayer.appendChild(span);
      }

      const terms = ['6', 'MARTIN', 'HASS', 'preußischen', 'Adreßkalender'];
      const result = pdfTextSearch.traceFootnoteFromAnchor(textLayer, terms, '6');

      console.log('Standalone anchor result:', result ? {
        spanCount: result.spans.length,
        score: result.totalScore,
        texts: result.spans.map(s => s.span.textContent.substring(0, 30))
      } : null);

      assert.ok(result, 'Should find a result');
      assert.ok(result.spans.length >= 3, 'Should trace multiple spans from standalone anchor');
      // First span should be the standalone "6", second should be the content
      assert.strictEqual(result.spans[0].span.textContent, '6', 'First span should be standalone anchor');
      assert.match(result.spans[1].span.textContent, /MARTIN HASS/, 'Second span should be footnote content');
    });

  });

});

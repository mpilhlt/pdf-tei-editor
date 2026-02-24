/**
 * Cross-browser E2E tests for the xmlTagSync CodeMirror extension.
 *
 * Mirrors the JSDOM unit tests in tests/unit/js/xml-tag-sync.test.js but runs
 * inside real browser engines to catch engine-specific differences (e.g. Chrome's
 * Lezer parser evaluating the syntax tree more eagerly than Firefox).
 *
 * The tests use an isolated harness page (tests/e2e/harness/xmleditor-harness.html)
 * that bootstraps only CodeMirror + xmlTagSync — no application login or state needed.
 *
 * @testCovers app/src/modules/codemirror/xml-tag-sync.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage } from './helpers/test-logging.js';

/**
 * @typedef {object} HarnessWindow
 * @property {(doc: string) => void} setContent
 * @property {(from: number, to: number, insert: string) => string} applyChange
 * @property {() => string} getContent
 */

const HARNESS = '/tests/e2e/harness/xmleditor-harness.html';

/**
 * Navigate to the harness and wait for the editor to signal readiness.
 * @param {import('@playwright/test').Page} page
 */
async function loadHarness(page) {
  const logs = setupTestConsoleCapture(page); 
  await page.goto(HARNESS);
  // @ts-ignore
  await waitForTestMessage(logs, 'EDITOR_READY', 10000);
}

// ---------------------------------------------------------------------------

test.describe('xmlTagSync – open → close sync', () => {
  test('syncs a single character insertion in the opening tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(4, 4, 'x');
    });
    expect(result).toBe('<tagx>text</tagx>');
  });

  test('syncs a single character deletion in the opening tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(3, 4, '');
    });
    expect(result).toBe('<ta>text</ta>');
  });

  test('syncs a full rename of the opening tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(1, 4, 'div');
    });
    expect(result).toBe('<div>text</div>');
  });

  test('syncs multiple sequential edits', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      w.applyChange(4, 4, 's');      // <tags>text</tags>
      return w.applyChange(5, 5, 'x'); // <tagsx>text</tagsx>
    });
    expect(result).toBe('<tagsx>text</tagsx>');
  });

  test('handles inserting then deleting (original bug scenario)', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      w.applyChange(4, 4, 'x'); // <tagx>text</tagx>
      return w.applyChange(4, 5, ''); // <tag>text</tag>
    });
    expect(result).toBe('<tag>text</tag>');
  });
});

// ---------------------------------------------------------------------------

test.describe('xmlTagSync – close → open sync', () => {
  test('syncs a character insertion in the closing tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(14, 14, 'x');
    });
    expect(result).toBe('<tagx>text</tagx>');
  });

  test('syncs a full rename of the closing tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(11, 14, 'div');
    });
    expect(result).toBe('<div>text</div>');
  });
});

// ---------------------------------------------------------------------------

test.describe('xmlTagSync – nested elements', () => {
  test('syncs only the outer tag, not nested tags', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<outer><inner>text</inner></outer>');
      return w.applyChange(1, 6, 'div');
    });
    expect(result).toBe('<div><inner>text</inner></div>');
  });

  test('syncs an inner tag without affecting the outer tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<outer><inner>text</inner></outer>');
      return w.applyChange(8, 13, 'span');
    });
    expect(result).toBe('<outer><span>text</span></outer>');
  });

  test('syncs the outer closing tag without matching inner opening tags', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<outer><inner>text</inner></outer>');
      return w.applyChange(28, 33, 'div');
    });
    expect(result).toBe('<div><inner>text</inner></div>');
  });

  test('handles deeply nested elements', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<a><b><c>x</c></b></a>');
      return w.applyChange(4, 5, 'bb');
    });
    expect(result).toBe('<a><bb><c>x</c></bb></a>');
  });

  test('handles multiple sibling elements', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<root><a>1</a><b>2</b></root>');
      return w.applyChange(7, 8, 'x');
    });
    expect(result).toBe('<root><x>1</x><b>2</b></root>');
  });
});

// ---------------------------------------------------------------------------

test.describe('xmlTagSync – edge cases', () => {
  test('does not act on self-closing tags (no counterpart)', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<root><br/>text</root>');
      return w.applyChange(7, 9, 'hr');
    });
    expect(result).toBe('<root><hr/>text</root>');
  });

  test('does not act when change is outside a tag name', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(5, 9, 'hello');
    });
    expect(result).toBe('<tag>hello</tag>');
  });

  test('handles attributes in the opening tag', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag attr="v">text</tag>');
      return w.applyChange(1, 4, 'div');
    });
    expect(result).toBe('<div attr="v">text</div>');
  });

  test('does not double-apply mirror changes (regression: Chrome re-runs filter on combined transaction)', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(1, 4, 'div');
    });
    expect(result).toBe('<div>text</div>');
  });

  test('does not corrupt document when structural text is inserted into content', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<bibl>text content</bibl>');
      return w.applyChange(10, 10, '</bibl><bibl>');
    });
    expect(result).toBe('<bibl>text</bibl><bibl> content</bibl>');
  });

  test('does not corrupt document when structural string is inserted in text content (Chrome ">>" regression)', async ({ page }) => {
    // Chrome's Lezer tree is more eagerly parsed. When "</bibl><bibl>" is inserted
    // near a TagName boundary, resolveTagName() may return that node in Chrome
    // but not in Firefox (stale/unparsed tree).
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<bibl>content</bibl>');
      return w.applyChange(9, 9, '</bibl><bibl>');
    });
    expect(result).toBe('<bibl>con</bibl><bibl>tent</bibl>');
  });

  test('does not corrupt when a replacement spans past a TagName boundary', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<bibl>text</bibl>');
      return w.applyChange(12, 17, 'bibl><bibl>');
    });
    expect(result).toBe('<bibl>text</bibl><bibl>');
  });

  test('does not mirror when newTagName contains XML-invalid characters', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<bibl>text</bibl>');
      return w.applyChange(1, 5, 'bibl><bibl');
    });
    expect(result).toBe('<bibl><bibl>text</bibl>');
  });

  test('does not sync when a replacement extends beyond the TagName span', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(1, 5, 'div>');
    });
    expect(result).toBe('<div>text</tag>');
  });

  test('does not sync when computed tag name contains markup characters', async ({ page }) => {
    await loadHarness(page);
    const result = await page.evaluate(() => {
      const w = /** @type {HarnessWindow} */ (/** @type {unknown} */ (window));
      w.setContent('<tag>text</tag>');
      return w.applyChange(1, 5, 'div><div>');
    });
    expect(result).toBe('<div><div>text</tag>');
  });
});

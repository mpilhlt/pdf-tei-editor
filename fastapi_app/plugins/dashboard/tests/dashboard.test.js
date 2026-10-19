/**
 * Unit tests for the dashboard frontend extension's packing algorithm.
 *
 * @testCovers fastapi_app/plugins/dashboard/extensions/dashboard.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

global.FrontendExtensionPlugin = class {};

const { packDashboard } = await import('../extensions/dashboard.js');

/**
 * @param {string} id
 * @param {number} cols
 * @param {number} rows
 * @param {number} priority
 */
const box = (id, cols, rows, priority) => ({ id, title: id, element: null, cols, rows, priority });

/**
 * Renders the packing result as a compact map: id -> [col, row, colSpan, rowSpan]
 * @param {ReturnType<typeof packDashboard>} result
 */
const layout = ({ placements }) => Object.fromEntries(
  placements.map(p => [p.item.id, [p.col, p.row, p.colSpan, p.rowSpan]])
);

/**
 * Asserts that every cell of the grid is covered exactly once.
 * @param {ReturnType<typeof packDashboard>} result
 */
function assertNoGapsOrOverlaps(result) {
  const cells = new Map();
  for (const p of result.placements) {
    for (let c = p.col; c < p.col + p.colSpan; c++) {
      for (let r = p.row; r < p.row + p.rowSpan; r++) {
        const key = `${c}:${r}`;
        assert.ok(!cells.has(key), `cell ${key} covered twice`);
        cells.set(key, p.item.id);
      }
    }
  }
  assert.strictEqual(cells.size, 2 * result.rows, 'grid has empty cells');
}

describe('packDashboard', () => {
  it('returns an empty layout for no contributions', () => {
    assert.deepStrictEqual(packDashboard([]), { placements: [], rows: 0 });
  });

  it('widens a single one-column box to both columns', () => {
    const result = packDashboard([box('a', 1, 3, 0)]);
    assert.deepStrictEqual(layout(result), { a: [0, 0, 2, 3] });
    assertNoGapsOrOverlaps(result);
  });

  it('places one-column boxes into the shorter column by priority and stretches the last one', () => {
    const result = packDashboard([box('low', 1, 1, 1), box('high', 1, 3, 10), box('mid', 1, 1, 5)]);
    assert.deepStrictEqual(layout(result), {
      high: [0, 0, 1, 3],
      mid: [1, 0, 1, 1],
      low: [1, 1, 1, 2]
    });
    assertNoGapsOrOverlaps(result);
  });

  it('fills the gap before a two-column box with a lower-priority box that fits exactly', () => {
    const result = packDashboard([
      box('recent', 1, 3, 100),
      box('progress', 1, 2, 50),
      box('announce', 2, 1, 40),
      box('review', 1, 1, 10)
    ]);
    assert.deepStrictEqual(layout(result), {
      recent: [0, 0, 1, 3],
      progress: [1, 0, 1, 2],
      review: [1, 2, 1, 1],
      announce: [0, 3, 2, 1]
    });
    assertNoGapsOrOverlaps(result);
  });

  it('stretches the shorter column before a two-column box when no box fits the gap', () => {
    const result = packDashboard([
      box('recent', 1, 3, 100),
      box('progress', 1, 1, 50),
      box('announce', 2, 1, 40),
      box('review', 1, 1, 10)
    ]);
    assert.deepStrictEqual(layout(result).progress, [1, 0, 1, 3]);
    assert.deepStrictEqual(layout(result).announce, [0, 3, 2, 1]);
    assertNoGapsOrOverlaps(result);
  });

  it('keeps contributions with equal priority in their original order', () => {
    const result = packDashboard([box('first', 1, 1, 0), box('second', 1, 1, 0)]);
    assert.deepStrictEqual(layout(result), { first: [0, 0, 1, 1], second: [1, 0, 1, 1] });
  });

  it('normalizes invalid sizes to one column and one row', () => {
    const result = packDashboard([{ id: 'x', title: 'x', element: null, cols: 3, rows: 0 }, box('y', 1, 1, 0)]);
    assert.deepStrictEqual(layout(result), { x: [0, 0, 1, 1], y: [1, 0, 1, 1] });
  });

  it('never leaves gaps for mixed layouts', () => {
    const sizes = [[1, 2], [2, 1], [1, 1], [1, 3], [2, 2], [1, 1], [1, 2]];
    for (let n = 1; n <= sizes.length; n++) {
      const items = sizes.slice(0, n).map(([cols, rows], i) => box(`b${i}`, cols, rows, n - i));
      assertNoGapsOrOverlaps(packDashboard(items));
    }
  });
});

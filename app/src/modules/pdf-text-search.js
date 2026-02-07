/**
 * PDF Text Search Module
 *
 * Provides text localization in PDF text layers using span-to-term matching.
 * Uses a reverse matching approach: instead of searching for terms in text,
 * scores each text layer span against the search terms and clusters high-scoring
 * spans spatially to find the best match location.
 *
 * This handles:
 * - Hyphenated words split across lines (e.g., "Gian-" + "na" -> "Gianna")
 * - OCR fragmentation (words split into multiple spans)
 * - Complex multi-column layouts
 */

/**
 * @typedef {Object} TermLookups
 * @property {Set<string>} termSet - Normalized terms
 * @property {Set<string>} prefixSet - All prefixes of terms (for hyphenation matching)
 * @property {RegExp} containmentRegex - Pre-compiled regex for containment check
 */

/**
 * @typedef {Object} SpanMatch
 * @property {HTMLElement} span - The matching span element
 * @property {Object} rect - Bounding rect relative to text layer
 * @property {number} rect.left
 * @property {number} rect.top
 * @property {number} rect.right
 * @property {number} rect.bottom
 * @property {number} rect.width
 * @property {number} rect.height
 * @property {number} score - Match score (0-10)
 * @property {string} text - First 50 chars of span text (for debugging)
 */

/**
 * @typedef {Object} Cluster
 * @property {SpanMatch[]} spans - Matched spans in this cluster
 * @property {number} totalScore - Sum of span scores
 * @property {Object} bounds - Bounding box
 * @property {number} bounds.left
 * @property {number} bounds.top
 * @property {number} bounds.right
 * @property {number} bounds.bottom
 * @property {number} bounds.width
 * @property {number} bounds.height
 */

/**
 * Builds lookup structures for efficient term matching.
 * @param {string[]} terms - Search terms
 * @returns {TermLookups} Lookup structures
 */
export function buildTermLookups(terms) {
  // Normalize all terms
  const normalizedTerms = terms
    .map(t => t.toLowerCase().trim())
    .filter(t => t.length > 0);

  const termSet = new Set(normalizedTerms);

  // Build prefix set for hyphenation matching
  // e.g., for "gianna", generate prefixes: "gi", "gia", "gian", "giann"
  const prefixSet = new Set();
  for (const term of normalizedTerms) {
    for (let i = 2; i < term.length; i++) {
      prefixSet.add(term.substring(0, i));
    }
  }

  // Pre-compile regex for containment check (efficient for many spans)
  let containmentRegex = /(?!)/; // Never-matching regex as fallback
  if (normalizedTerms.length > 0) {
    const escapedTerms = normalizedTerms.map(t =>
      t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    containmentRegex = new RegExp(escapedTerms.join('|'), 'i');
  }

  return { termSet, prefixSet, containmentRegex };
}

/**
 * Scores how well a span's text matches the search terms.
 *
 * Scoring hierarchy:
 * - 10: Exact match (span equals a term)
 * - 7: Prefix match (span is start of a term, handles hyphenation)
 * - 5: Containment (term is contained within span)
 * - 3: Suffix match (span is end of a term, handles line continuations)
 * - 0: No match
 *
 * @param {string} spanText - Text content of span
 * @param {TermLookups} lookups - From buildTermLookups
 * @returns {number} Score 0-10
 */
export function scoreSpan(spanText, lookups) {
  const { termSet, prefixSet, containmentRegex } = lookups;

  // Normalize: lowercase, strip trailing hyphen (continuation marker), trim
  const text = spanText.toLowerCase().replace(/-$/, '').trim();

  if (text.length < 2) return 0;

  // Exact match: span equals a term (score 10)
  if (termSet.has(text)) return 10;

  // Prefix match: span is start of a term - hyphenation case (score 7)
  // e.g., span "gian" matches prefix of term "gianna"
  if (text.length >= 2 && prefixSet.has(text)) return 7;

  // Containment: term fully contained in span (score 5)
  // e.g., span "dr.gianna" contains term "gianna"
  if (containmentRegex.test(text)) return 5;

  // Suffix match: span is end of a term (score 3)
  // e.g., span "na" is suffix of "gianna" (if "gian-" was in previous span)
  // Only check short spans (likely continuations)
  if (text.length >= 2 && text.length <= 4) {
    for (const term of termSet) {
      if (term.length > text.length && term.endsWith(text)) return 3;
    }
  }

  return 0;
}

/**
 * Finds all spans in a text layer that match any search term.
 * @param {HTMLElement} textLayer - The text layer element
 * @param {string[]} terms - Search terms
 * @returns {SpanMatch[]} Array of matching spans with scores and positions
 */
export function findMatchingSpans(textLayer, terms) {
  const lookups = buildTermLookups(terms);
  const textLayerRect = textLayer.getBoundingClientRect();
  const matches = [];

  // Get the CSS transform scale applied to the text layer
  // getBoundingClientRect returns visual (post-transform) positions,
  // but when positioning children we need pre-transform coordinates
  const computedStyle = window.getComputedStyle(textLayer);
  const transform = computedStyle.transform;
  let scale = 1;
  if (transform && transform !== 'none') {
    // Extract scale from matrix(a, b, c, d, tx, ty) where a = scaleX
    const match = transform.match(/matrix\(([^,]+)/);
    if (match) {
      scale = parseFloat(match[1]) || 1;
    }
  }

  const spans = textLayer.querySelectorAll('span');
  for (const span of spans) {
    const text = span.textContent || '';
    const score = scoreSpan(text, lookups);

    if (score > 0) {
      const spanRect = span.getBoundingClientRect();
      // Convert to coordinates relative to text layer,
      // compensating for CSS transform scale
      const rect = {
        left: (spanRect.left - textLayerRect.left) / scale,
        top: (spanRect.top - textLayerRect.top) / scale,
        right: (spanRect.right - textLayerRect.left) / scale,
        bottom: (spanRect.bottom - textLayerRect.top) / scale,
        width: spanRect.width / scale,
        height: spanRect.height / scale
      };

      matches.push({
        span,
        rect,
        score,
        text: text.substring(0, 50)
      });
    }
  }

  return matches;
}

/**
 * Groups matching spans into spatial clusters using union-find algorithm.
 * Spans are clustered if they are within the specified thresholds.
 *
 * @param {SpanMatch[]} spans - Array of matching spans
 * @param {number} [verticalThreshold=14] - Max vertical distance in pixels
 * @param {number} [horizontalThreshold=60] - Max horizontal distance in pixels
 * @returns {Cluster[]} Array of clusters, sorted by total score (descending)
 */
export function clusterSpansByProximity(spans, verticalThreshold = 14, horizontalThreshold = 60) {
  if (spans.length === 0) return [];

  // Calculate center points for each span
  const centers = spans.map(m => ({
    x: m.rect.left + m.rect.width / 2,
    y: m.rect.top + m.rect.height / 2
  }));

  // Union-Find data structure
  const parent = spans.map((_, i) => i);
  const rank = spans.map(() => 0);

  const find = (i) => {
    if (parent[i] !== i) {
      parent[i] = find(parent[i]);
    }
    return parent[i];
  };

  const union = (i, j) => {
    const pi = find(i);
    const pj = find(j);
    if (pi === pj) return;
    if (rank[pi] < rank[pj]) {
      parent[pi] = pj;
    } else if (rank[pi] > rank[pj]) {
      parent[pj] = pi;
    } else {
      parent[pj] = pi;
      rank[pi]++;
    }
  };

  // Build clusters by connecting nearby spans
  // Two spans are neighbors if within BOTH vertical and horizontal thresholds
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const dx = Math.abs(centers[i].x - centers[j].x);
      const dy = Math.abs(centers[i].y - centers[j].y);
      if (dy <= verticalThreshold && dx <= horizontalThreshold) {
        union(i, j);
      }
    }
  }

  // Group spans by their root parent
  const clusterMap = new Map();
  for (let i = 0; i < spans.length; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) {
      clusterMap.set(root, []);
    }
    clusterMap.get(root).push(spans[i]);
  }

  // Convert to cluster objects with bounds and total score
  const clusters = Array.from(clusterMap.values()).map(clusterSpans => {
    let minLeft = Infinity, minTop = Infinity;
    let maxRight = -Infinity, maxBottom = -Infinity;
    let totalScore = 0;

    for (const item of clusterSpans) {
      minLeft = Math.min(minLeft, item.rect.left);
      minTop = Math.min(minTop, item.rect.top);
      maxRight = Math.max(maxRight, item.rect.right);
      maxBottom = Math.max(maxBottom, item.rect.bottom);
      totalScore += item.score;
    }

    return {
      spans: clusterSpans,
      totalScore,
      bounds: {
        left: minLeft,
        top: minTop,
        right: maxRight,
        bottom: maxBottom,
        width: maxRight - minLeft,
        height: maxBottom - minTop
      }
    };
  });

  // Sort by score density (score / area), then by total score
  clusters.sort((a, b) => {
    const areaA = Math.max(1, a.bounds.width * a.bounds.height);
    const areaB = Math.max(1, b.bounds.width * b.bounds.height);
    const densityA = a.totalScore / areaA;
    const densityB = b.totalScore / areaB;

    if (Math.abs(densityA - densityB) > 0.0001) {
      return densityB - densityA;
    }
    return b.totalScore - a.totalScore;
  });

  return clusters;
}

/**
 * Estimates the average line height from text layer spans.
 * @param {HTMLElement} textLayer - The text layer element
 * @returns {number} Estimated line height in pixels
 */
function estimateLineHeight(textLayer) {
  const spans = textLayer.querySelectorAll('span');
  if (spans.length === 0) return 14; // Default fallback

  // Sample up to 10 spans
  const sampleSize = Math.min(10, spans.length);
  let totalHeight = 0;

  for (let i = 0; i < sampleSize; i++) {
    const span = spans[i];
    const rect = span.getBoundingClientRect();
    totalHeight += rect.height;
  }

  return Math.max(10, totalHeight / sampleSize);
}

/**
 * Finds the best cluster of matching spans in a text layer.
 * Main entry point for text localization.
 *
 * @param {HTMLElement} textLayer - The text layer element
 * @param {string[]} terms - Search terms
 * @param {Object} [options={}] - Options
 * @param {number} [options.minClusterSize=5] - Minimum spans required in cluster
 * @param {number} [options.maxLines=5] - Maximum cluster height in lines (scales with zoom)
 * @param {number} [options.verticalThresholdLines=1.2] - Clustering vertical threshold in lines
 * @param {number} [options.horizontalThresholdChars=8] - Clustering horizontal threshold in avg char widths
 * @returns {Cluster|null} Best cluster or null if none found
 */
export function findBestCluster(textLayer, terms, options = {}) {
  const {
    minClusterSize = 5,
    maxLines = 5,
    verticalThresholdLines = 1.2,
    horizontalThresholdChars = 8
  } = options;

  // Estimate line height to make thresholds zoom-independent
  const lineHeight = estimateLineHeight(textLayer);
  const avgCharWidth = lineHeight * 0.6; // Approximate character width

  // Convert line-based thresholds to pixels
  const maxHeight = lineHeight * maxLines;
  const verticalThreshold = lineHeight * verticalThresholdLines;
  const horizontalThreshold = avgCharWidth * horizontalThresholdChars;

  // Find all matching spans
  const matchingSpans = findMatchingSpans(textLayer, terms);

  if (matchingSpans.length === 0) {
    return null;
  }

  // Cluster spans by spatial proximity
  const clusters = clusterSpansByProximity(matchingSpans, verticalThreshold, horizontalThreshold);

  // Filter clusters by size and height constraints
  const validClusters = clusters.filter(c =>
    c.spans.length >= minClusterSize && c.bounds.height <= maxHeight
  );

  if (validClusters.length > 0) {
    return validClusters[0]; // Best valid cluster (already sorted by score)
  }

  // Fallback: relax height to 1.5x, keep minClusterSize
  const relaxedHeightClusters = clusters.filter(c =>
    c.spans.length >= minClusterSize && c.bounds.height <= maxHeight * 1.5
  );

  if (relaxedHeightClusters.length > 0) {
    return relaxedHeightClusters[0];
  }

  // Last resort: reduce minClusterSize to 60% (minimum 2)
  const absoluteMin = Math.max(2, Math.floor(minClusterSize * 0.6));
  if (clusters.length > 0 && clusters[0].spans.length >= absoluteMin) {
    return clusters[0];
  }

  return null;
}

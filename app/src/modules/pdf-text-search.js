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
  // Exclude very short terms (1-2 chars) from containment - they cause too many false positives
  // (e.g., "2" matching inside "2016", "482", etc.)
  let containmentRegex = /(?!)/; // Never-matching regex as fallback
  const containmentTerms = normalizedTerms.filter(t => t.length >= 3);
  if (containmentTerms.length > 0) {
    const escapedTerms = containmentTerms.map(t =>
      t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    containmentRegex = new RegExp(escapedTerms.join('|'), 'i');
  }

  return { termSet, prefixSet, containmentRegex };
}

/**
 * Scores how well a span's text matches the search terms.
 *
 * Scoring hierarchy (adjusted by term length to reduce noise from short common words):
 * - 10: Exact match for long term (6+ chars)
 * - 6: Exact match for medium term (4-5 chars)
 * - 3: Exact match for short term (2-3 chars, common words like "und", "die")
 * - 2: Exact match for single char (footnote numbers only)
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

  if (text.length === 0) return 0;

  // Exact match: span equals a term
  // Score based on term length to reduce noise from common short words
  if (termSet.has(text)) {
    if (text.length >= 6) return 10;  // Long distinctive terms: full score
    if (text.length >= 4) return 6;   // Medium terms: reduced score
    if (text.length >= 2) return 3;   // Short common words (und, die, als): low score
    return 2;                          // Single char (footnote numbers): minimal score
  }

  // For non-exact matches, require at least 2 chars to avoid noise
  if (text.length < 2) return 0;

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
 * Counts how many unique search terms are matched in a span's text.
 * Used for term concentration scoring.
 *
 * @param {string} spanText - Text content of span
 * @param {TermLookups} lookups - From buildTermLookups
 * @returns {number} Count of unique matched terms
 */
export function countMatchedTerms(spanText, lookups) {
  const { termSet } = lookups;
  const text = spanText.toLowerCase().trim();

  if (text.length === 0) return 0;

  let count = 0;

  // Check each term for exact or containment match
  for (const term of termSet) {
    if (text === term || text.includes(term)) {
      count++;
    }
  }

  return count;
}

/**
 * Calculates what fraction of a span's words are NOT in the search terms.
 * Used to filter out false-positive spans that contain noise words.
 *
 * @param {string} spanText - Text content of span
 * @param {TermLookups} lookups - From buildTermLookups
 * @returns {{noiseRatio: number, matchedCount: number, totalCount: number}} Noise ratio and word counts
 */
export function calculateSpanNoise(spanText, lookups) {
  const { termSet, prefixSet, containmentRegex } = lookups;

  // Remove punctuation and split into words
  const text = spanText.toLowerCase().replace(/[.,;:!?()\[\]{}'"„""«»-]/g, ' ').trim();
  const words = text.split(/\s+/).filter(w => w.length >= 2); // Only words with 2+ chars

  if (words.length === 0) {
    return { noiseRatio: 0, matchedCount: 0, totalCount: 0 };
  }

  let matchedCount = 0;
  for (const word of words) {
    // Check if this word matches any search term
    let isMatch = false;

    // Exact match
    if (termSet.has(word)) {
      isMatch = true;
    }
    // Prefix match (word is prefix of a term - hyphenation)
    else if (prefixSet.has(word)) {
      isMatch = true;
    }
    // Containment match (word contains a term)
    else if (containmentRegex.test(word)) {
      isMatch = true;
    }
    // Suffix match (word is suffix of a term)
    else {
      for (const term of termSet) {
        if (term.length > word.length && term.endsWith(word)) {
          isMatch = true;
          break;
        }
        // Also check if the term is contained in the word
        if (word.includes(term)) {
          isMatch = true;
          break;
        }
      }
    }

    if (isMatch) {
      matchedCount++;
    }
  }

  const noiseRatio = words.length > 0 ? (words.length - matchedCount) / words.length : 0;
  return { noiseRatio, matchedCount, totalCount: words.length };
}

/**
 * Finds all spans in a text layer that match any search term.
 * Filters out spans with high noise ratio (too many unmatched words).
 *
 * @param {HTMLElement} textLayer - The text layer element
 * @param {string[]} terms - Search terms
 * @param {Object} [options={}] - Options
 * @param {number} [options.maxNoiseRatio=0.7] - Max fraction of unmatched words (0-1)
 * @returns {SpanMatch[]} Array of matching spans with scores and positions
 */
export function findMatchingSpans(textLayer, terms, options = {}) {
  const { maxNoiseRatio = 0.7 } = options;
  const lookups = buildTermLookups(terms);
  const textLayerRect = textLayer.getBoundingClientRect();
  const matches = [];
  let rejectedByNoise = 0;

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
      // Check noise ratio - reject spans with too many unmatched words
      const { noiseRatio, totalCount } = calculateSpanNoise(text, lookups);

      // Only apply noise filter to spans with multiple words
      // Single-word spans that score > 0 are always kept
      if (totalCount >= 2 && noiseRatio > maxNoiseRatio) {
        rejectedByNoise++;
        continue;
      }

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
  // Build clusters by connecting nearby spans
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

  // Split clusters at column gaps (large horizontal distance between span centers)
  // This prevents cross-column clusters even when chained through vertical proximity
  const columnGapThreshold = 120; // pixels - center distance larger than this suggests column boundary
  const splitClusters = [];

  for (const clusterSpans of clusterMap.values()) {
    if (clusterSpans.length <= 1) {
      splitClusters.push(clusterSpans);
      continue;
    }

    // Sort spans by x center position to detect column groups
    const sortedByX = [...clusterSpans].sort((a, b) => {
      const centerA = a.rect.left + a.rect.width / 2;
      const centerB = b.rect.left + b.rect.width / 2;
      return centerA - centerB;
    });

    // Find column gaps and split based on center-to-center distance
    let currentGroup = [sortedByX[0]];
    for (let i = 1; i < sortedByX.length; i++) {
      const prevCenter = sortedByX[i - 1].rect.left + sortedByX[i - 1].rect.width / 2;
      const currCenter = sortedByX[i].rect.left + sortedByX[i].rect.width / 2;
      const centerDistance = currCenter - prevCenter;

      if (centerDistance > columnGapThreshold) {
        // Column gap detected - start new group
        splitClusters.push(currentGroup);
        currentGroup = [sortedByX[i]];
      } else {
        currentGroup.push(sortedByX[i]);
      }
    }
    splitClusters.push(currentGroup);
  }

  // Convert to cluster objects with bounds and total score
  const clusters = splitClusters.map(clusterSpans => {
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

  // Sort by compactness-adjusted score
  // Prefer clusters that are: high score, small area, not too wide
  clusters.sort((a, b) => {
    const areaA = Math.max(1, a.bounds.width * a.bounds.height);
    const areaB = Math.max(1, b.bounds.width * b.bounds.height);

    // Calculate density (score per pixel)
    const densityA = a.totalScore / areaA;
    const densityB = b.totalScore / areaB;

    // Width penalty: penalize clusters wider than 200px (likely cross-column)
    const widthPenaltyA = a.bounds.width > 200 ? (a.bounds.width - 200) / 100 : 0;
    const widthPenaltyB = b.bounds.width > 200 ? (b.bounds.width - 200) / 100 : 0;

    // Adjusted density = density - width penalty
    const adjustedDensityA = densityA - widthPenaltyA * 0.001;
    const adjustedDensityB = densityB - widthPenaltyB * 0.001;

    if (Math.abs(adjustedDensityA - adjustedDensityB) > 0.0001) {
      return adjustedDensityB - adjustedDensityA;
    }

    // Tie-breaker: prefer upper-left clusters (reading order)
    if (a.bounds.top !== b.bounds.top) {
      return a.bounds.top - b.bounds.top;
    }
    return a.bounds.left - b.bounds.left;
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
 * @param {number} [options.maxLines=8] - Maximum cluster height in lines (scales with zoom)
 * @param {number} [options.verticalThresholdLines=4.0] - Clustering vertical threshold in lines
 * @param {number} [options.horizontalThresholdChars=60] - Clustering horizontal threshold in avg char widths
 * @param {string|null} [options.anchorTerm=null] - If set, cluster must contain exact match for this term
 * @returns {Cluster|null} Best cluster or null if none found
 */
export function findBestCluster(textLayer, terms, options = {}) {
  const {
    minClusterSize = 5,
    maxLines = 8,
    verticalThresholdLines = 4.0,
    horizontalThresholdChars = 60,  // Allow clustering across full line width (~400px)
    anchorTerm = null
  } = options;

  // If anchor term is provided, use the tracing approach for better footnote detection
  if (anchorTerm) {
    const tracedResult = traceFootnoteFromAnchor(textLayer, terms, anchorTerm);
    if (tracedResult && tracedResult.spans.length >= 2) {
      return tracedResult;
    }
  }

  const anchorLower = anchorTerm?.toLowerCase();

  // Estimate line height to make thresholds zoom-independent
  const lineHeight = estimateLineHeight(textLayer);
  const avgCharWidth = lineHeight * 0.6; // Approximate character width

  // Convert line-based thresholds to pixels
  const maxHeight = lineHeight * maxLines;
  const verticalThreshold = lineHeight * verticalThresholdLines;
  // Use tighter horizontal threshold for non-anchored searches to avoid cross-column merging
  const effectiveHorizontalChars = anchorTerm ? horizontalThresholdChars : Math.min(horizontalThresholdChars, 25);
  const horizontalThreshold = avgCharWidth * effectiveHorizontalChars;
  // Max cluster width to prevent cross-column clusters (tighter for non-anchored searches)
  const maxWidth = anchorTerm ? lineHeight * 30 : lineHeight * 18; // ~200px for non-anchored

  // Find all matching spans with noise filtering
  // Use stricter noise threshold for non-anchored searches
  const noiseThreshold = anchorTerm ? 0.8 : 0.6;
  const matchingSpans = findMatchingSpans(textLayer, terms, { maxNoiseRatio: noiseThreshold });

  if (matchingSpans.length === 0) {
    return null;
  }

  // Cluster spans by spatial proximity
  let clusters = clusterSpansByProximity(matchingSpans, verticalThreshold, horizontalThreshold);

  // Build term lookups for calculating unique term coverage per cluster
  const lookups = buildTermLookups(terms);

  // Calculate unique term coverage for each cluster and re-sort
  // This ensures clusters matching more distinct terms rank higher
  for (const cluster of clusters) {
    const matchedTerms = new Set();
    for (const spanMatch of cluster.spans) {
      const spanText = spanMatch.span.textContent.toLowerCase();
      for (const term of lookups.termSet) {
        if (spanText.includes(term)) {
          matchedTerms.add(term);
        }
      }
    }
    cluster.uniqueTermCount = matchedTerms.size;
    cluster.termCoverage = terms.length > 0 ? matchedTerms.size / terms.length : 0;
  }

  // Re-sort clusters by term coverage first, then by density
  clusters.sort((a, b) => {
    // Primary: term coverage (prefer clusters matching more unique terms)
    const coverageDiff = b.termCoverage - a.termCoverage;
    if (Math.abs(coverageDiff) > 0.1) {
      return coverageDiff > 0 ? 1 : -1;
    }

    // Secondary: density-adjusted score (existing logic)
    const areaA = Math.max(1, a.bounds.width * a.bounds.height);
    const areaB = Math.max(1, b.bounds.width * b.bounds.height);
    const densityA = a.totalScore / areaA;
    const densityB = b.totalScore / areaB;
    const widthPenaltyA = a.bounds.width > 200 ? (a.bounds.width - 200) / 100 : 0;
    const widthPenaltyB = b.bounds.width > 200 ? (b.bounds.width - 200) / 100 : 0;
    const adjustedDensityA = densityA - widthPenaltyA * 0.001;
    const adjustedDensityB = densityB - widthPenaltyB * 0.001;

    if (Math.abs(adjustedDensityA - adjustedDensityB) > 0.0001) {
      return adjustedDensityB - adjustedDensityA;
    }

    // Tie-breaker: prefer upper-left clusters (reading order)
    if (a.bounds.top !== b.bounds.top) {
      return a.bounds.top - b.bounds.top;
    }
    return a.bounds.left - b.bounds.left;
  });

  // If anchorTerm is set (footnote number), look for spans that START with the anchor FOLLOWED BY content
  // This avoids matching superscript references like "4" - we want "4 Vgl..." or "4Die..."
  if (anchorLower) {
    // Find clusters with a span that starts with anchor followed by content (not just the number alone)
    const clustersWithAnchorStart = clusters.filter(c =>
      c.spans.some(s => {
        const text = s.span.textContent.toLowerCase().trim();
        // Must start with anchor followed by space+text or directly by a letter
        return text.startsWith(anchorLower + ' ') ||
               (text.startsWith(anchorLower) && text.length > anchorLower.length && /[a-z]/i.test(text[anchorLower.length]));
      })
    );

    if (clustersWithAnchorStart.length > 0) {
      clusters = clustersWithAnchorStart;
    } else {
      // Fallback: just require anchor to be present somewhere (includes superscripts)
      const clustersWithAnchor = clusters.filter(c =>
        c.spans.some(s => s.span.textContent.toLowerCase().trim() === anchorLower)
      );
      if (clustersWithAnchor.length > 0) {
        clusters = clustersWithAnchor;
      }
    }
  }

  // Filter clusters by size, height, and width constraints
  const validClusters = clusters.filter(c =>
    c.spans.length >= minClusterSize && c.bounds.height <= maxHeight && c.bounds.width <= maxWidth
  );

  if (validClusters.length > 0) {
    return validClusters[0]; // Best valid cluster (already sorted by score)
  }

  // Fallback: relax height to 1.5x, keep width and minClusterSize
  const relaxedHeightClusters = clusters.filter(c =>
    c.spans.length >= minClusterSize && c.bounds.height <= maxHeight * 1.5 && c.bounds.width <= maxWidth
  );

  if (relaxedHeightClusters.length > 0) {
    return relaxedHeightClusters[0];
  }

  // Last resort: reduce minClusterSize to 60% (minimum 2), still respect width
  const absoluteMin = Math.max(2, Math.floor(minClusterSize * 0.6));
  const narrowClusters = clusters.filter(c => c.bounds.width <= maxWidth);
  if (narrowClusters.length > 0 && narrowClusters[0].spans.length >= absoluteMin) {
    return narrowClusters[0];
  }

  return null;
}

/**
 * Traces a footnote's content starting from its anchor (footnote number).
 * Instead of clustering all matching spans, this finds the anchor span and
 * follows the text flow until hitting the next footnote or a large gap.
 *
 * @param {HTMLElement} textLayer - The text layer element
 * @param {string[]} terms - Search terms (for scoring)
 * @param {string} anchorTerm - The footnote number to find
 * @returns {Cluster|null} The traced footnote as a cluster, or null if not found
 */
export function traceFootnoteFromAnchor(textLayer, terms, anchorTerm) {
  const anchorLower = anchorTerm.toLowerCase();
  const lineHeight = estimateLineHeight(textLayer);
  const lookups = buildTermLookups(terms);

  // Get all spans with positions
  const allSpans = Array.from(textLayer.querySelectorAll('span')).map(span => {
    const rect = span.getBoundingClientRect();
    const textLayerRect = textLayer.getBoundingClientRect();
    return {
      span,
      rect: {
        left: rect.left - textLayerRect.left,
        top: rect.top - textLayerRect.top,
        right: rect.right - textLayerRect.left,
        bottom: rect.bottom - textLayerRect.top,
        width: rect.width,
        height: rect.height
      },
      text: span.textContent.toLowerCase().trim()
    };
  });

  // Find ALL candidate anchor spans (footnote number followed by content)
  // There may be multiple on the page (e.g., one in main text, one in footnotes section)
  // Pattern 1: anchor + content in same span (e.g., "6 MARTIN HASS...")
  let anchorCandidates = allSpans.filter(s => {
    return s.text.startsWith(anchorLower + ' ') ||
           (s.text.startsWith(anchorLower) && s.text.length > anchorLower.length && /[a-z]/i.test(s.text[anchorLower.length]));
  });

  // Pattern 2: standalone anchor number where next span has the content
  // (PDF renders "6" and "MARTIN HASS..." as separate spans)
  if (anchorCandidates.length === 0) {
    const standaloneAnchors = allSpans.filter(s => s.text === anchorLower);
    for (const anchor of standaloneAnchors) {
      // Find the next span in reading order (same line or next line, close horizontally)
      // Use generous thresholds since PDF rendering varies widely
      const nearbySpans = allSpans.filter(s => {
        if (s === anchor) return false;
        const yDiff = s.rect.top - anchor.rect.top;
        const xDiff = s.rect.left - anchor.rect.right;
        // Same line: within half line height vertically, to the right within 100px
        const sameLine = Math.abs(yDiff) < lineHeight * 0.7 && xDiff > -5 && xDiff < 100;
        // Next line: below within 2 line heights, roughly same column
        const nextLine = yDiff > 0 && yDiff < lineHeight * 2 && Math.abs(s.rect.left - anchor.rect.left) < lineHeight * 5;
        return sameLine || nextLine;
      }).sort((a, b) => {
        // Sort by reading order: y first, then x
        const yDiff = a.rect.top - b.rect.top;
        if (Math.abs(yDiff) > lineHeight * 0.3) return yDiff;
        return a.rect.left - b.rect.left;
      });

      // Skip empty spans to find actual content
      const nonEmptyNearbySpans = nearbySpans.filter(s => s.text.length > 0);

      const nextSpan = nonEmptyNearbySpans[0];
      if (nextSpan && /^[a-z]/i.test(nextSpan.text)) {
        // This standalone anchor has content in the next span - it's a valid footnote start
        anchorCandidates.push(anchor);
      }
    }
  }

  if (anchorCandidates.length === 0) {
    return null;
  }

  // Trace from each candidate anchor and pick the best one (highest score)
  const columnThreshold = lineHeight * 3;
  const lineGapThreshold = lineHeight * 2;
  // Match footnote starts: "6 text", "6text", or standalone "6"
  const footnoteStartRegex = /^\d+[\s\u00A0]/;
  const standaloneNumberRegex = /^\d+$/;

  let bestResult = null;
  let bestScore = -1;

  for (const anchorSpan of anchorCandidates) {
    const tracedSpans = [anchorSpan];
    let lastY = anchorSpan.rect.top;
    const anchorX = anchorSpan.rect.left;
    let rightmostX = anchorSpan.rect.right; // Track rightmost edge for same-line continuation

    // Sort remaining spans by y position, then x
    const remainingSpans = allSpans
      .filter(s => s !== anchorSpan && s.rect.top >= anchorSpan.rect.top)
      .sort((a, b) => {
        const yDiff = a.rect.top - b.rect.top;
        if (Math.abs(yDiff) > lineHeight * 0.5) return yDiff;
        return a.rect.left - b.rect.left;
      });

    for (const span of remainingSpans) {
      const yDiffFromLast = Math.abs(span.rect.top - lastY);
      // Use more generous same-line threshold to handle font/baseline variations
      const isOnSameLine = yDiffFromLast < lineHeight * 1.0;

      // For spans on the same line, allow continuation to the right (text flows horizontally)
      // For spans on new lines, check column alignment with anchor
      if (isOnSameLine) {
        // Same line: span should be to the right of current content (with small gap tolerance)
        // OR span should be close to where we expect text to continue
        if (span.rect.left < rightmostX - 20 && span.rect.left < anchorX) continue; // Skip spans to the left of anchor
      } else {
        // New line: check column alignment with anchor
        const xDistance = Math.abs(span.rect.left - anchorX);
        if (xDistance > columnThreshold) continue;
      }

      const yGap = span.rect.top - lastY;
      if (yGap > lineGapThreshold) break;

      // Check if this span starts a new footnote (different number than our anchor)
      // Pattern 1: "6 text" or "6\u00A0text"
      if (footnoteStartRegex.test(span.text)) {
        const spanNumber = span.text.match(/^(\d+)/)?.[1];
        if (spanNumber && spanNumber !== anchorLower) {
          break;
        }
      }
      // Pattern 2: standalone number like "6" (followed by content in next span)
      if (standaloneNumberRegex.test(span.text) && span.text !== anchorLower) {
        break;
      }

      tracedSpans.push(span);
      lastY = span.rect.top;
      rightmostX = Math.max(rightmostX, span.rect.right);
    }

    if (tracedSpans.length === 1) continue; // Skip if only anchor found

    // Calculate score for this trace based on unique term coverage and noise ratio
    // This prefers traces that match more distinct search terms with less extraneous content
    const matchedTerms = new Set();
    let spanScoreSum = 0;
    let totalWords = 0;
    let matchedWords = 0;

    for (const item of tracedSpans) {
      const text = item.span.textContent.toLowerCase();
      spanScoreSum += scoreSpan(text, lookups);

      // Count words and track which match search terms
      const words = text.split(/\s+/).filter(w => w.length > 0);
      totalWords += words.length;

      for (const word of words) {
        // Check if this word matches any search term
        for (const term of lookups.termSet) {
          if (word === term || word.includes(term) || term.includes(word)) {
            matchedWords++;
            matchedTerms.add(term);
            break;
          }
        }
      }
    }

    // Calculate noise ratio: what fraction of words DON'T match search terms
    // noiseRatio = 0 means all words match, 1 means no words match
    const noiseRatio = totalWords > 0 ? (totalWords - matchedWords) / totalWords : 1;

    // Score prioritizes term coverage over trace length
    // - Primary: unique terms matched (heavily weighted)
    // - Secondary: span score sum
    // - Penalty: only if noise ratio is very high AND term coverage is low
    const uniqueTermScore = matchedTerms.size * 20; // Increased weight for term coverage
    const termCoverage = terms.length > 0 ? matchedTerms.size / terms.length : 0;

    // Only penalize noise if term coverage is poor (< 30%)
    // This prevents penalizing legitimate footnotes that have filler words
    const noisePenalty = termCoverage < 0.3 ? Math.round(noiseRatio * 10) : 0;
    const totalScore = uniqueTermScore + spanScoreSum - noisePenalty;

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestResult = { tracedSpans, anchorSpan };
    }
  }

  if (!bestResult) {
    return null;
  }

  // Build result from best trace
  const { tracedSpans } = bestResult;
  let minLeft = Infinity, minTop = Infinity;
  let maxRight = -Infinity, maxBottom = -Infinity;

  const resultSpans = tracedSpans.map(item => {
    const score = scoreSpan(item.span.textContent, lookups);
    minLeft = Math.min(minLeft, item.rect.left);
    minTop = Math.min(minTop, item.rect.top);
    maxRight = Math.max(maxRight, item.rect.right);
    maxBottom = Math.max(maxBottom, item.rect.bottom);

    return {
      span: item.span,
      score,
      rect: item.rect
    };
  });

  return {
    spans: resultSpans,
    totalScore: bestScore,
    bounds: {
      left: minLeft,
      top: minTop,
      right: maxRight,
      bottom: maxBottom,
      width: maxRight - minLeft,
      height: maxBottom - minTop
    }
  };
}

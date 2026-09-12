/**
 * Collection Coverage Overview — client logic.
 *
 * Fetches the aggregated collection x variant rows from /data, then renders
 * KPI tiles, the faceted filter bar, and the sortable coverage table
 * entirely client-side (row counts are small - a few dozen at most - so no
 * pagination/virtualization library is needed).
 */

const sessionId = new URLSearchParams(window.location.search).get('session_id') || '';

let ROWS = [];
let LIFECYCLE_ORDER = [];
let STAGE_COLORS = [];
const facetState = { collection: new Set(), variant: new Set() };
let attentionOnly = false;
let sortState = { col: null, dir: 1 };

const ATTENTION_PROGRESS_THRESHOLD = 45;

// -- Ordinal color ramp ------------------------------------------------------
// Lifecycle stage is a position in an ordered sequence, not an identity, so
// it takes a single-hue OKLCH ramp (monotone lightness) rather than one hue
// per stage. These parameters were validated with the dataviz skill's
// validate_palette.js --ordinal (adjacent ΔL >= 0.06, light-end contrast
// >= 2:1 on white, single hue) for 8 stages. The ramp is generated at
// runtime - not hardcoded - so it always matches the server's configured
// annotation.lifecycle.order, however many stages that has.
const RAMP_HUE = 195;
const RAMP_CHROMA = 0.095;
const RAMP_L_START = 0.72; // least progress
const RAMP_L_END = 0.20;   // most progress

function oklchToHex(L, C, H) {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const toHex = (c) => {
    const clamped = Math.min(1, Math.max(0, c));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(255 * Math.min(1, Math.max(0, srgb))).toString(16).padStart(2, '0');
  };
  return `#${toHex(rl)}${toHex(gl)}${toHex(bl)}`;
}

function buildStageRamp(n) {
  if (n === 0) return [];
  if (n <= 1) return [oklchToHex(0.46, RAMP_CHROMA, RAMP_HUE)];
  const ramp = [];
  for (let i = 0; i < n; i++) {
    const L = RAMP_L_START + ((RAMP_L_END - RAMP_L_START) * i) / (n - 1);
    ramp.push(oklchToHex(L, RAMP_CHROMA, RAMP_HUE));
  }
  return ramp;
}

function stageColor(i) { return STAGE_COLORS[i] || '#888888'; }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// -- Data loading -------------------------------------------------------------

async function loadData() {
  const res = await fetch('/api/plugins/collection-overview/data', {
    headers: { 'X-Session-ID': sessionId },
  });
  if (!res.ok) {
    document.getElementById('app').innerHTML = `<p class="error">Failed to load coverage data (${res.status}).</p>`;
    return;
  }
  const data = await res.json();
  ROWS = data.rows;
  LIFECYCLE_ORDER = data.lifecycle_order;
  STAGE_COLORS = buildStageRamp(LIFECYCLE_ORDER.length);

  renderLegend();
  renderFacetPanel('collection');
  renderFacetPanel('variant');
  render();
}

function renderLegend() {
  document.getElementById('legend-start').textContent = LIFECYCLE_ORDER[0] || '';
  document.getElementById('legend-end').textContent = LIFECYCLE_ORDER[LIFECYCLE_ORDER.length - 1] || '';
  document.getElementById('legend-ramp').style.background = `linear-gradient(90deg, ${STAGE_COLORS.join(',')})`;
}

// -- Derived per-row values ---------------------------------------------------

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function dominantStage(stageCounts) {
  let best = null, bestCount = 0;
  LIFECYCLE_ORDER.forEach((name) => {
    const n = stageCounts[name] || 0;
    if (n > bestCount) { best = name; bestCount = n; }
  });
  return best;
}

function avgProgressFromRow(row) { return Math.round(row.avg_progress); }

function isAttention(row) {
  return avgProgressFromRow(row) < ATTENTION_PROGRESS_THRESHOLD || !dominantStage(row.stage_counts);
}

function variantLabel(variant) { return variant || '— none —'; }

// -- KPI tiles ------------------------------------------------------------

function facetFilteredRows() {
  return ROWS.filter((r) => {
    const variantKey = r.variant || '__none__';
    const okCollection = !facetState.collection.size || facetState.collection.has(r.collection_id);
    const okVariant = !facetState.variant.size || facetState.variant.has(variantKey);
    return okCollection && okVariant;
  });
}

function renderKpis(rows) {
  const distinctCollections = new Map();
  rows.forEach((r) => {
    if (!distinctCollections.has(r.collection_id)) {
      distinctCollections.set(r.collection_id, r.total_docs);
    }
  });
  const totalDocs = [...distinctCollections.values()].reduce((a, b) => a + b, 0);
  const needsAttention = rows.filter(isAttention).length;

  document.getElementById('kpi-collections').textContent = distinctCollections.size;
  document.getElementById('kpi-docs').textContent = totalDocs;
  document.getElementById('kpi-combinations').textContent = rows.length;
  document.getElementById('kpi-attention').textContent = `${needsAttention} / ${rows.length}`;
}

// -- Table rendering --------------------------------------------------------

function stageSegBar(row) {
  const docs = row.total_docs;
  const counts = row.stage_counts;
  const total = LIFECYCLE_ORDER.reduce((sum, name) => sum + (counts[name] || 0), 0);
  if (!docs || !total) {
    return '<span class="seg-bar empty"><span style="width:100%"></span></span>';
  }
  const segs = LIFECYCLE_ORDER.map((name, i) => {
    const n = counts[name] || 0;
    if (!n) return '';
    const share = (n / docs) * 100;
    return `<span title="${escapeHtml(name)}: ${n} of ${docs} documents (${Math.round(share)}%)" style="width:${share.toFixed(2)}%;background:${stageColor(i)}"></span>`;
  }).join('');
  return `<span class="seg-bar">${segs}</span>`;
}

function renderRow(row) {
  const goldPct = pct(row.gold_count, row.total_docs);
  const progress = avgProgressFromRow(row);
  const dom = dominantStage(row.stage_counts);
  const domIdx = dom ? LIFECYCLE_ORDER.indexOf(dom) : -1;
  const attention = isAttention(row);
  const noStatus = row.stage_counts['no-status'] || 0;
  const variantPill = row.variant
    ? `<span class="variant-pill">${escapeHtml(row.variant)}</span>`
    : `<span class="variant-pill none">— none —</span>`;
  const progressUrl = `/api/plugins/annotation-progress/view?collection=${encodeURIComponent(row.collection_id)}` +
    (row.variant ? `&variant=${encodeURIComponent(row.variant)}` : '');

  return `<tr class="${attention ? 'attention' : ''}" data-attn="${attention ? 1 : 0}"
            data-collection="${escapeHtml(row.collection_id)}" data-variant="${row.variant ? escapeHtml(row.variant) : '__none__'}">
    <td class="coll">${escapeHtml(row.collection_name)}<span class="sub">${escapeHtml(row.collection_id)}</span></td>
    <td>${variantPill}</td>
    <td class="num">${row.total_docs}</td>
    <td>
      <div class="gold ${goldPct < 50 ? 'low' : ''}">
        <span class="frac num">${row.gold_count}/${row.total_docs}</span>
        <span class="bar"><span style="width:${goldPct}%"></span></span>
      </div>
    </td>
    <td>
      <div class="stages">
        <span class="progress-num" style="color:${dom ? stageColor(domIdx) : 'var(--text-faint)'}">${dom ? progress + '%' : '—'}</span>
        <div class="bar-col">
          ${stageSegBar(row)}
          <div class="dominant">
            ${dom
              ? `<span class="dot" style="background:${stageColor(domIdx)}"></span><span>mostly ${escapeHtml(dom)}${noStatus > 0 ? ` · ${noStatus} no status` : ''}</span>`
              : `<span class="dot" style="background:var(--track)"></span><span>no status yet</span>`}
          </div>
        </div>
      </div>
    </td>
    <td class="action">
      <a href="#" data-progress-url="${escapeHtml(progressUrl)}" onclick="event.preventDefault(); sandbox.openControlledWindow(this.dataset.progressUrl).catch((err) => alert('Could not open Annotation Progress: ' + err.message));" title="Open Annotation Progress for ${escapeHtml(row.collection_name)} / ${row.variant ? escapeHtml(row.variant) : 'default'}">
        Open progress
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>
    </td>
  </tr>`;
}

function render() {
  document.getElementById('rows').innerHTML = ROWS.map(renderRow).join('');
  applyFilters();
}

// -- Sorting ---------------------------------------------------------------

function sortBy(col, th) {
  const numeric = th.hasAttribute('data-num');
  document.querySelectorAll('thead th').forEach((h) => h.classList.remove('sorted'));
  th.classList.add('sorted');
  sortState.dir = sortState.col === col ? -sortState.dir : 1;
  sortState.col = col;
  const getters = [
    (r) => r.collection_name,
    (r) => r.variant || '',
    (r) => r.total_docs,
    (r) => pct(r.gold_count, r.total_docs),
    (r) => avgProgressFromRow(r),
  ];
  ROWS.sort((a, b) => {
    const av = getters[col](a), bv = getters[col](b);
    if (numeric) return (av - bv) * sortState.dir;
    return String(av).localeCompare(String(bv)) * sortState.dir;
  });
  render();
}
window.sortBy = sortBy;

// -- Faceted filters ---------------------------------------------------------
// Stand-in for <sl-select multiple> (tag-format): a plain HTML/CSS/JS control,
// not the real Shoelace component, since this page is a standalone document
// outside the app's Shoelace bundle. Within a facet, checked values are OR'd;
// across facets, AND'd. Selecting a collection narrows the Variant facet to
// only variants present in the selected collection(s).

function facetValues(facet, { scopeToCollections } = {}) {
  const seen = new Map();
  ROWS.forEach((r) => {
    if (facet === 'variant' && scopeToCollections && scopeToCollections.size && !scopeToCollections.has(r.collection_id)) {
      return;
    }
    const value = facet === 'collection' ? r.collection_id : (r.variant || '__none__');
    const label = facet === 'collection' ? r.collection_name : variantLabel(r.variant);
    if (!seen.has(value)) seen.set(value, { label, count: 0 });
    seen.get(value).count += 1;
  });
  return [...seen.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
}

function renderFacetPanel(facet) {
  const panel = document.getElementById(`panel-${facet}`);
  const selected = facetState[facet];
  const scoped = facet === 'variant' ? facetState.collection : null;
  panel.innerHTML = facetValues(facet, { scopeToCollections: scoped }).map(([value, { label, count }]) => `
    <label class="facet-option">
      <input type="checkbox" data-facet="${facet}" data-value="${escapeHtml(value)}" ${selected.has(value) ? 'checked' : ''}
             onchange="onFacetToggle(this.dataset.facet, this.dataset.value, this.checked)">
      <span class="opt-label">${escapeHtml(label)}</span>
      <span class="opt-count">${count}</span>
    </label>`).join('');
}

function renderFacetTags(facet) {
  const wrap = document.getElementById(`tags-${facet}`);
  const selected = [...facetState[facet]];
  if (!selected.length) {
    wrap.innerHTML = `<span class="placeholder">All ${facet === 'collection' ? 'collections' : 'variants'}</span>`;
    return;
  }
  const values = facetValues(facet);
  wrap.innerHTML = selected.map((value) => {
    const found = values.find(([v]) => v === value);
    const label = found ? found[1].label : value;
    return `<span class="tag-chip">${escapeHtml(label)}<button type="button" data-facet="${facet}" data-value="${escapeHtml(value)}" onclick="event.stopPropagation(); onFacetToggle(this.dataset.facet, this.dataset.value, false)">✕</button></span>`;
  }).join('');
}

function onFacetToggle(facet, value, checked) {
  checked ? facetState[facet].add(value) : facetState[facet].delete(value);
  if (facet === 'collection') {
    const offered = new Set(facetValues('variant', { scopeToCollections: facetState.collection }).map(([v]) => v));
    [...facetState.variant].forEach((v) => { if (!offered.has(v)) facetState.variant.delete(v); });
    renderFacetTags('variant');
    renderFacetPanel('variant');
  }
  renderFacetTags(facet);
  renderFacetPanel(facet);
  applyFilters();
}
window.onFacetToggle = onFacetToggle;

function toggleFacetPanel(facet) {
  const isOpen = document.getElementById(`panel-${facet}`).classList.contains('open');
  ['collection', 'variant'].forEach((f) => {
    document.getElementById(`panel-${f}`).classList.remove('open');
    document.getElementById(`ctrl-${f}`).classList.remove('open');
  });
  if (!isOpen) {
    document.getElementById(`panel-${facet}`).classList.add('open');
    document.getElementById(`ctrl-${facet}`).classList.add('open');
  }
}
window.toggleFacetPanel = toggleFacetPanel;

document.addEventListener('click', (e) => {
  if (!e.target.closest('.fake-select')) {
    ['collection', 'variant'].forEach((f) => {
      document.getElementById(`panel-${f}`).classList.remove('open');
      document.getElementById(`ctrl-${f}`).classList.remove('open');
    });
  }
});

function clearFacets() {
  facetState.collection.clear();
  facetState.variant.clear();
  ['collection', 'variant'].forEach((f) => { renderFacetTags(f); renderFacetPanel(f); });
  applyFilters();
}
window.clearFacets = clearFacets;

function toggleAttention() {
  const box = document.getElementById('attnCheck');
  const wrap = document.getElementById('attnToggle');
  attentionOnly = box.checked;
  wrap.classList.toggle('on', attentionOnly);
  applyFilters();
}
window.toggleAttention = toggleAttention;

function applyFilters() {
  const anyFilterActive = facetState.collection.size || facetState.variant.size;
  document.getElementById('clearFilters').hidden = !anyFilterActive;
  document.querySelectorAll('#rows tr').forEach((tr) => {
    const okCollection = !facetState.collection.size || facetState.collection.has(tr.dataset.collection);
    const okVariant = !facetState.variant.size || facetState.variant.has(tr.dataset.variant);
    const okAttention = !attentionOnly || tr.dataset.attn === '1';
    tr.style.display = okCollection && okVariant && okAttention ? '' : 'none';
  });
  renderKpis(facetFilteredRows());
}

loadData();

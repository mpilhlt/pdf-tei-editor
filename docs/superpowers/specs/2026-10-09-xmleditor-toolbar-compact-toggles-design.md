# XML Editor Toolbar: Compact Toggle Buttons — Design Spec

Date: 2026-10-09
Status: Approved for planning

## Problem

The XML editor's top toolbar (`app/src/templates/xmleditor-toolbar.html`,
wired by `app/src/plugins/xmleditor.js` and `app/src/plugins/tei-tools.js`)
is too crowded. Three `<status-switch>` elements ("Ignore ␣¶", "Wrap",
"Header") each render a labeled Shoelace `sl-switch`, which is far wider
than the icon-only buttons that make up the rest of the toolbar. There is
also no visual relationship between the "Header" fold/unfold switch
(owned by `tei-tools.js`) and the unrelated "Edit header metadata" button
(owned by `app/src/plugins/tei-header-editor.js`), even though both are
about the document's `<teiHeader>` and read as one group to the user.

Separately, the "Ignore whitespace/linebreaks" toggle's semantics are
backwards for a toolbar where "on" should be the visually loud, attention-
grabbing state: today it defaults to **on** (ignoring whitespace), so the
toolbar shows an active-looking control in its default state.

## Decision

### 1. New widget: `StatusToggleButton`

New file `app/src/modules/panels/widgets/status-toggle-button.js`, class
`StatusToggleButton`, custom element tag `<status-toggle-button>`,
**subclassing `StatusButton`** (`status-button.js`) rather than extending
`StatusSwitch` or bolting toggle behavior onto `StatusButton` directly —
this reuses `StatusButton`'s existing icon rendering and keeps
`StatusButton` itself (used elsewhere for plain actions) unchanged.

Attributes/behavior added on top of `StatusButton`:

- `checked` (boolean, reflected attribute) — the on/off state.
- `disabled` — inherited from `StatusButton`.
- Clicking toggles `checked` and fires a `widget-change` CustomEvent with
  `detail: { checked }` (mirrors `StatusSwitch`'s event shape, so plugin
  wiring code changes minimally when migrating from `<status-switch>`).
- `aria-pressed` reflects `checked` for accessibility.
- Tooltip: internally wraps its icon in a real Shoelace `sl-tooltip`
  (not `StatusButton`'s current native `title` attribute) so hover
  timing/placement matches the rest of the app's tooltip convention
  (already used throughout `xmleditor-tei-buttons.html`,
  `xmleditor-import-export-buttons.html`, etc). The tooltip text is the
  button's accessible label — since the button has no visible text label,
  this is the only place the label exists.

### 2. Visual style — "filled pill" (style A)

Chosen from four visual concepts presented as mockups (plain icon-outline
corner-dot, pressed/inset-shadow illusion, outline-vs-accent-border, and
this one), because it's the only one where the on/off signal survives a
disabled state (see below) and is unambiguous at a glance:

- **Off**: default button chrome (neutral border/background, `--sl-color-neutral` text).
- **On**: filled with the accent color, white/contrasting icon.
- **Disabled** (either on or off): desaturated + a subtle diagonal hatch
  overlay on top of whichever off/on fill it had — so disabled-on
  (muted accent fill) stays visibly distinct from disabled-off (muted
  neutral fill), instead of collapsing to one indistinguishable "grayed
  out" look.

### 3. Toolbar changes

Three existing `<status-switch>` elements in `xmleditor-toolbar.html`
become `<status-toggle-button>`:

- `ignoreWhitespaceSwitch` → renamed **`strictDiffToggle`**, semantics
  inverted (see §4), tooltip "Strict diff (whitespace & linebreaks
  significant)". Stays in the same toolbar position as today: grouped
  with, and sharing the same enabled/disabled condition as, the diff
  prev/next/reject/accept buttons (all five are only meaningful/enabled
  during merge/diff view, per current `mergeViewActive`-gated disabling
  in `xmleditor.js`).
- `lineWrappingSwitch` → renamed **`wrapToggle`**, same semantics
  (checked = line wrapping on), same disabled condition (`!state.xml`).
  Stays in its own toolbar slot, separate from the diff group — it has
  an independent enabled condition and no relation to diff view.
- `teiHeaderToggleWidget` (header fold/unfold) → renamed
  **`headerFoldToggle`**, same semantics, same disabled logic
  (`tei-tools.js`).

Icon-only buttons already in the toolbar (validate/undo/redo,
upload/download, revision history, XSL viewer, theme picker, menu) are
unaffected — they're already compact and already use `sl-tooltip`.

### 4. "Strict diff" semantics (inverted from today's "Ignore")

- Default: **unchecked** (off). Behavior: ignore whitespace/linebreaks
  in the diff — i.e. today's default behavior is preserved, just
  represented by the toggle being *off* instead of *on*.
- Checked (on): whitespace/linebreaks become significant in the diff
  ("strict" comparison).
- The underlying editor method (`xmlEditor.setIgnoreWhitespaceInDiff`)
  is not renamed as part of this change — the toolbar wiring in
  `xmleditor.js` calls it with the inverted value
  (`setIgnoreWhitespaceInDiff(!checked)`). Renaming the lower-level API
  is out of scope.
- The persisted `uiStorage` key changes from `ignoreWhitespaceInDiff`
  to `strictDiff` (boolean, default `false`) to match the inverted
  meaning — old persisted preference values are not migrated (per
  project convention: no backwards-compatibility shims for a simple UI
  preference reset).

### 5. Header group — fused "segmented pill"

The fold/unfold toggle (`headerFoldToggle`, owned by `tei-tools.js`) and
the "Edit header metadata" button (`headerEditorBtn`, owned by
`tei-header-editor.js`, stays a plain `<status-button>` since it's a
momentary action, not a toggle) are rendered as two adjacent buttons with
no gap and a shared outer border radius (first button: rounded left
corners only; second: rounded right corners only; shared 1px border
between them) — confirmed as the only option that fits the toolbar's
height constraint, from four grouping mockups (fused segmented pair,
loosely-grouped pair in a dashed outline, primary-button-plus-caret
combo, and labeled segmented pair).

**Adjacency requirement**: visual fusion requires the two buttons to be
adjacent DOM siblings with no whitespace between them — the existing
generic `addToolbarWidget(widget, priority)` mechanism
(`xmleditor.js:1066`), which independently priority-sorts widgets
contributed by different plugins, cannot guarantee this reliably.
Instead:

- `xmleditor-toolbar.html` gains a static wrapper element (e.g.
  `<span class="status-toggle-group" data-group="header">`) containing
  `headerFoldToggle`.
  `status-toggle-group` is a new small CSS utility class added to the
  shared panel widget styles (not header-specific) — removes
  inter-button border/gap and shared border-radius for any two (or
  more) adjacent `status-button`/`status-toggle-button` elements placed
  inside it, so it is reusable for future grouped controls, not a
  header-only hack.
- `tei-header-editor.js` looks up that wrapper (e.g. via a new
  `ui.xmlEditor.toolbar.headerGroup` reference) and appends its
  `headerEditorBtn` into it directly, instead of calling the generic
  `addToolbarWidget()` priority-based insertion it uses today. This
  removes the cross-plugin ordering fragility of relying on priority
  numbers to achieve adjacency.
- Each button keeps its own independent `disabled` binding (fold toggle
  per `tei-tools.js`'s logic, edit button per
  `tei-header-editor.js`'s `userIsAnnotatorOnly`/document-presence
  logic) — grouping is purely visual, not a merge of behavior.

**Revision (2026-10-09, post-implementation)**: after seeing the fused
pair next to the rest of the toolbar's existing flat (borderless) icon
buttons, the bordered look read as inconsistent rather than as an
intentional grouping. Decision changed to prioritize toolbar-wide visual
consistency over the fused/segmented look:

- `StatusToggleButton` gained an `appearance` attribute: `"toolbar"`
  (default, the original bordered "filled pill" described above) and a
  new `"flat"` variant — borderless, sized to match plain
  `<status-button>` siblings (ghost when off, solid accent fill when
  checked).
- `strictDiffToggle`, `wrapToggle`, and `headerFoldToggle` all use
  `appearance="flat"`.
- `status-toggle-group` no longer fuses its children (no shared border,
  no border-radius flattening, no negative margin) — it's now just an
  `inline-flex` wrapper with a small gap, kept only so `headerFoldToggle`
  and `headerEditorBtn` stay visually adjacent as a loose pairing. The
  grouping is now purely proximity, not a fused control.

## Out of scope

- No changes to icon-only buttons that aren't switches today.
- No change to the lower-level `setIgnoreWhitespaceInDiff` editor API
  name.
- No migration of old persisted `ignoreWhitespaceInDiff` /
  `teiHeaderVisible` / `lineWrapping` uiStorage values.
- No changes to `StatusSwitch` itself — it remains available for any
  other labeled-switch usage elsewhere in the app.

## Incidental cleanup

While touching `tei-header-editor.js` for the header-group change, also
remove the leftover `console.error('DEBUG tei-header-editor: ...')`
tracing lines (currently at lines 50, 63, 65, 71) left over from a prior
debugging commit — unrelated to this toolbar redesign but in the same
file.

# Enhancements for IAA Analyzer plugin

**Character-level inline diff:**

- Implement enhanced cropping function using `Diff.diffChars()`
- Show exact character changes within lines
- Highlight only changed portions, crop identical portions within line

**Advanced navigation:**

- Collapsible identical context sections
- XPath display and navigation
- Jump to specific diff block
- Search within diffs

**Additional visualizations:**

- Element-level tree diff view
- Attribute-only comparison mode
- Text-content-only comparison mode

**Export options:**

- Download comparison as HTML
- Generate PDF report
- Export diff as JSON for programmatic analysis

**Performance optimizations:**

- Server-side diff computation for very large documents
- Progressive loading for many diff blocks
- Virtualization for long diff lists

**Configuration of semantic mode:**

- store ingnore rules in config instead of hardcoding
- Configurable ignore rules via UI

### Other enhancements

- Diff caching for large documents
- Three-way diff support

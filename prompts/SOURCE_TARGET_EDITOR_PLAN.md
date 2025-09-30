# Source-to-Target Editor Implementation Plan

## Overview
This plan implements a comprehensive dual-editor system that transforms the application from a PDF-specific TEI editor into a general source-to-target document processing tool. The system supports:
- **Source Editor**: PDF viewer OR XML editor (left pane)
- **Target Editor**: XML editor (right pane)
- **Flexible Workflows**: PDF→XML, XML→XML, XML→Schema generation
- **Generic Extraction**: Any source format to any target format via pluggable extractors

## Current Status: Core Infrastructure Complete ✅

### Achievements So Far
**File System & Data Management**:
- ✅ Extended file discovery to support standalone XML files
- ✅ Implemented file type classification system (pdf-xml, xml-only, schema)
- ✅ Added .rng/.xsd file type support with proper MIME type serving
- ✅ Created schema file storage in collection/variant structure

**Generic Extraction System**:
- ✅ Redesigned extraction API from PDF-specific to generic file-based
- ✅ Implemented dynamic extractor input type detection
- ✅ Created RelaxNG schema extractor with robust XML parsing
- ✅ Fixed validation system integration for schema files
- ✅ Added proper schema URL generation and hash synchronization

**Backend Infrastructure**:
- ✅ Generalized extraction endpoints to work with any source file type
- ✅ Implemented secure file serving with exclusive allow lists
- ✅ Fixed XML namespace handling and attribute processing
- ✅ Added RelaxNG validation URL integration

**Technical Foundation**:
- ✅ Extractor architecture supports both PDF and XML inputs seamlessly
- ✅ State management handles XML-only workflows
- ✅ File resolution and caching work for all file types
- ✅ Validation system recognizes and processes schema files

## Phase 1: Source Editor Implementation 🔄

### 1.1 Preparatory steps: refactor state properties, PDF/XML Source Detection
- [ ] Rename state properties "xml" and "pdf" to "source" and "target" throughout the codebase.
- [ ] Prefix the source or target type to the file id hash, e.g. "source=pdf:d8e2a" or "target=xml:hff54e"
- [ ] Thoroughly test that nothing has broken.
- [ ] Detect source type from loaded file (PDF vs XML)
- [ ] Add source type indicators to UI
- [ ] Update file selection to show source compatibility

### 1.2 Source XML Editor Plugin
- [ ] Create `SourceXmlEditor` plugin class extending existing XML editor
- [ ] Implement read-only mode for source viewing
- [ ] Add source-specific UI controls and toolbars
- [ ] Handle different XML types (TEI, RNG, generic XML)

### 1.3 Source-Target Coordination
- [ ] Implement dual-pane layout system (side-by-side editors)
- [ ] Create source/target role management
- [ ] Add editor synchronization for navigation/scrolling
- [ ] Implement source-to-target extraction workflows

## Phase 2: UI Architecture Redesign 🔄

### 2.1 Layout System
- [ ] Design responsive dual-pane layout
  - [ ] Collapsible source panel for PDF-only workflows
  - [ ] Resizable editor panes
  - [ ] Mobile-friendly stacked layout
- [ ] Update toolbar to show source/target context
- [ ] Add editor role indicators and controls

### 2.2 File Selection Enhancement
- [ ] Update file selection to handle source types
- [ ] Add visual indicators for workflow types:
  - [ ] PDF→XML (traditional workflow)
  - [ ] XML→XML (transformation/schema workflows)
  - [ ] Standalone XML editing
- [ ] Implement smart file pairing suggestions

### 2.3 Editor Management
- [ ] Create editor coordination system
- [ ] Implement editor state synchronization
- [ ] Add editor role switching capabilities
- [ ] Handle independent editor operations

## Phase 3: Workflow System 🔄

### 3.1 Source-Target Workflows
- [ ] PDF→XML extraction (existing, enhanced)
- [ ] XML→XML transformation workflows
- [ ] XML→Schema generation (working, needs UI integration)
- [ ] Standalone XML editing mode

### 3.2 Extraction Dialog Enhancement
- [ ] Dynamic extractor filtering based on source type
- [ ] Source-specific extraction options
- [ ] Target format selection
- [ ] Workflow preview and validation

### 3.3 State Management Extension
- [ ] Extend application state for dual editors:
  - [ ] `state.source` (type, content, metadata)
  - [ ] `state.target` (type, content, metadata)
  - [ ] `state.workflow` (source→target type mapping)
- [ ] Maintain backward compatibility with existing state

## Phase 4: Advanced Features 🔄

### 4.1 Schema Workflow Integration
- [ ] Real-time schema validation with generated schemas
- [ ] Schema refinement and iteration workflows
- [ ] Schema testing against sample documents
- [ ] Schema export and sharing

### 4.2 Transformation Pipelines
- [ ] Multi-step extraction workflows
- [ ] XSLT transformation support
- [ ] Custom processing pipeline creation
- [ ] Template and pattern library

### 4.3 Import/Export System
- [ ] Batch file processing
- [ ] Drag-and-drop file handling
- [ ] Multiple format support
- [ ] Workflow templates and presets

## Phase 5: Semantic Code Refactoring 🔄

### 5.1 Variable and Function Renaming
**Frontend State Properties**:
- [ ] `state.pdf` → `state.source` (with backward compatibility alias)
- [ ] `state.xml` → `state.target` (with backward compatibility alias)
- [ ] Add `state.sourceType` and `state.targetType` properties
- [ ] Update all state references throughout codebase

**UI Component Names**:
- [ ] `ui.toolbar.pdf` → `ui.toolbar.source`
- [ ] `ui.toolbar.xml` → `ui.toolbar.target`
- [ ] `pdfViewer` → `sourceViewer` or `sourceEditor`
- [ ] `xmlEditor` → `targetEditor`

**Function and Method Names**:
- [ ] `loadPdf()` → `loadSource()`
- [ ] `extractFromPdf()` → `extractFromSource()`
- [ ] `onChangePdfSelection()` → `onChangeSourceSelection()`
- [ ] `validateXml()` → `validateTarget()`

### 5.2 API Endpoint Generalization
**Backend Endpoints**:
- [ ] `/api/extract` - already supports generic `file_id` parameter ✅
- [ ] File upload endpoints - support multiple source types
- [ ] Validation endpoints - use source/target terminology
- [ ] Maintain full backward compatibility

**Plugin Communication**:
- [ ] Update plugin endpoint calls to use generalized methods
- [ ] Update plugin state management to new property names
- [ ] Migrate plugin dependencies to source/target interfaces

### 5.3 Documentation and Type Definitions
- [ ] Update JSDoc type definitions for new naming scheme
- [ ] Update TypeScript interfaces and type guards
- [ ] Update API documentation and OpenAPI specs
- [ ] Create migration guide for plugin developers

### 5.4 Template and UI Updates
- [ ] Update HTML templates to use source/target terminology
- [ ] Update CSS selectors and styling classes
- [ ] Update accessibility labels and ARIA descriptions
- [ ] Update user-facing text and help documentation

## Phase 6: Testing and Quality Assurance 🔄

### 6.1 Comprehensive Test Suite
- [ ] Unit tests for dual editor system
- [ ] Integration tests for all workflow types
- [ ] E2E tests for source-target transformations
- [ ] Backward compatibility validation
- [ ] Performance testing with large files

### 6.2 User Experience Testing
- [ ] Workflow usability testing
- [ ] Mobile responsiveness validation
- [ ] Accessibility compliance testing
- [ ] Browser compatibility verification

## Implementation Strategy

### Development Approach
1. **Incremental Migration**: Implement new features alongside existing ones
2. **Backward Compatibility**: Maintain full compatibility with existing PDF-TEI workflows
3. **User Testing**: Continuous validation with real users and workflows
4. **Progressive Enhancement**: Start with core dual-editor, add advanced features gradually

### Technical Principles
- **Source Agnostic**: Source editor handles any input type (PDF, XML, etc.)
- **Target Focused**: Target editor specialized for XML editing and validation
- **Workflow Driven**: UI adapts to source→target workflow requirements
- **Plugin Extensible**: New source types and extractors can be added easily

### Migration Path
1. Implement dual editor layout (preserves existing single-editor workflows)
2. Add source type detection and basic XML source editing
3. Enhance extraction system for XML→XML workflows
4. Gradually rename variables and functions with deprecation warnings
5. Complete semantic refactoring while maintaining backward compatibility

## Success Metrics
- [ ] All existing PDF-TEI workflows continue to work unchanged
- [ ] XML-to-XML workflows are fully functional
- [ ] Schema generation and validation works end-to-end
- [ ] New source types can be added without breaking changes
- [ ] Code semantics clearly reflect source-target architecture

---

*This plan transforms the PDF-TEI editor into a general-purpose source-to-target document processing tool while maintaining full backward compatibility and enhancing the user experience.*
# Data Extraction Process

The PDF-TEI Editor provides AI-powered extraction capabilities to automatically identify and extract bibliographic references from PDF documents using various extraction engines.

## Extraction Methods

### Extract from Current PDF (<!-- <sl-icon name="clipboard2-plus"></sl-icon> -->)
Re-extract references from the currently loaded PDF document:

1. **Click Extract Current**: Click the <!-- <sl-icon name="clipboard2-plus"></sl-icon> --> button in the Extraction toolbar section
2. **Automatic DOI Detection**: The system attempts to:
   - Extract DOI from existing XML header (`//tei:teiHeader//tei:idno[@type='DOI']`)
   - Extract DOI from PDF filename if it follows DOI naming conventions
3. **Collection Auto-detection**: Determines collection from PDF file path
4. **Process with Current Settings**: Uses the document's existing metadata and settings

### Extract from New PDF (<!-- <sl-icon name="filetype-pdf"></sl-icon> -->)
Upload and extract references from a new PDF document:

1. **Click Extract New**: Click the <!-- <sl-icon name="filetype-pdf"></sl-icon> --> button in the Extraction toolbar section  
2. **File Upload**: Select a PDF file from your computer
3. **File Validation**: System verifies the uploaded file is a valid PDF
4. **Automatic Processing**: Attempts to extract DOI from filename
5. **Load Results**: Extracted XML and PDF are loaded into the interface

## Extraction Options Dialog

Both extraction methods open a configuration dialog with the following options:

### Basic Settings
- **DOI**: Document Object Identifier (auto-populated when possible)
  - Validates DOI format using CrossRef standards
  - Can be left empty if not available
  - Format: `10.XXXX/XXXXX` (e.g., `10.1234/example.2023`)

- **Collection**: Target collection for the document
  - Defaults to `__inbox` for new uploads
  - Shows available collections from your access permissions
  - Cannot be changed if document already belongs to a collection

### Extraction Engine Selection
- **Model/Engine Dropdown**: Choose from available extraction engines
  - Only shows extractors that support PDF input and TEI document output
  - Each engine may have different capabilities and accuracy
  - Common engines include specialized legal/humanities models

### Dynamic Extractor Options
Options change based on selected extraction engine:

#### Instructions
- **Instruction Sets**: Pre-configured prompts for different document types
- **Custom Instructions**: Add specific guidance for the extraction process
- **Domain-specific**: Legal, humanities, or general academic instruction sets

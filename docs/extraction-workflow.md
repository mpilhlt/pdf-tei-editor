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

#### Model-Specific Settings
Different extractors may offer:
- **Language Settings**: Primary language of the document
- **Reference Types**: Focus on specific types of citations
- **Output Formats**: Different levels of detail in extracted data
- **Confidence Thresholds**: Minimum confidence for extracted references

## Extraction Process

### Processing Steps
1. **Validation**: System validates all input parameters
2. **Queue Submission**: Extraction job is queued on the server
3. **Progress Indication**: Spinner shows "Extracting references, please wait"
4. **AI Processing**: Selected extraction engine processes the PDF:
   - Text extraction from PDF
   - Reference identification
   - Bibliographic data structuring
   - TEI markup generation
5. **Result Generation**: Creates structured TEI XML document
6. **File System Update**: Updates document listings and collections

### Processing Time
- **Simple Documents**: 30 seconds to 2 minutes
- **Complex Documents**: 2-10 minutes depending on length and complexity
- **Large Documents**: May take longer for documents with many references
- **Network Factors**: Processing time depends on server load and model availability

## Extraction Results

### Generated TEI Structure
The extraction process creates a complete TEI document with:

- **TEI Header**: Document metadata including:
  - Title information
  - Source publication details  
  - DOI and other identifiers
  - Processing information

- **Bibliography Sections**: Structured `<biblStruct>` elements containing:
  - Author information (`<author>`, `<persName>`, `<forename>`, `<surname>`)
  - Title data (`<title>` with appropriate levels)
  - Publication details (`<imprint>`, `<date>`, `<publisher>`)
  - Identifiers (`<idno>` for DOI, ISBN, etc.)

### Quality Control Features
- **Automatic Validation**: Generated XML is validated against TEI schema
- **Confidence Scoring**: Some extractors provide confidence metrics
- **Error Flagging**: Potential issues are marked for manual review
- **Status Tracking**: All extracted nodes start as "unresolved" for manual verification

## Post-Extraction Workflow

### Immediate Actions
1. **Review Results**: Examine extracted bibliographic data
2. **Validation Check**: Address any schema validation errors
3. **Node Verification**: Use floating panel to mark nodes as verified or problematic
4. **Quality Assessment**: Compare against PDF source for accuracy

### Integration with Existing Data
When re-extracting from current PDF:
- **Merge View**: System shows differences between old and new extractions
- **Selective Integration**: Choose which changes to accept or reject
- **Version Management**: Previous versions are preserved
- **Change Tracking**: All modifications are documented

## Troubleshooting Extraction

### Common Issues
- **Empty Results**: PDF may have no extractable references
- **Malformed Output**: Extraction engine encountered processing errors
- **Timeout Errors**: Large documents may exceed processing time limits
- **Invalid DOI**: DOI format validation failures

### Error Resolution
- **Retry with Different Engine**: Try alternative extraction models
- **Modify Instructions**: Adjust prompts for better results
- **Manual Intervention**: Use manual editing for problematic sections
- **Report Issues**: Document persistent problems for system improvement

### Best Practices
- **Verify DOI**: Ensure DOI accuracy before extraction
- **Choose Appropriate Engine**: Select model suited for document type
- **Review Instructions**: Customize prompts for specific domains
- **Validate Results**: Always review extracted data for accuracy
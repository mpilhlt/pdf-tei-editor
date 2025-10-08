# PDF-TEI Editor Documentation

A comprehensive viewer/editor web application for comparing PDF sources with TEI extraction and annotation results, specifically designed for creating gold standard datasets of TEI documents from legal and humanities literature.

> The first draft of this documentation has been created using ai tools (Claude Code). It will be corrected and expanded incrementally. Please report any issues on the [GitHub repository](github.com/mpilhlt/pdf-tei-editor/issues).

## Overview

The PDF-TEI Editor is a specialized tool that helps researchers create, validate, and refine TEI (Text Encoding Initiative) documents extracted from PDF files. It features a dual-pane interface with PDF viewer and XML editor, making it easy to compare source documents with their extracted bibliographic data.

For detailed information about the project background and research context, see [About the PDF-TEI Editor](about.md).

## Table of Contents

### Getting Started

- [Authentication](authentication.md)
- [Interface Overview](interface-overview.md)

### Core Workflows  

- [Main Extraction and Editing Workflow](extraction-workflow.md)
- TODO: [Document Editing](editing-workflow.md)


### Advanced Features

- TODO: [File Synchronization](sync-workflow.md)
- TODO: [Document Comparison and Merging](merging-workflow.md)
- TODO: [Access Control and Permissions](access-control.md)
- TODO: [Collection Management](collection-management.md)

## Quick Start

1. **Login**: Access the application at your configured URL and login with your credentials
2. **Load a PDF**: Select a PDF from the dropdown menu in the top-left toolbar
3. **Review/Extract**: View existing TEI data or extract new references using AI models
4. **Edit and Validate**: Use the XML editor to refine the TEI markup and validate against schemas
5. **Save and Manage**: Create document versions, manage access permissions, and sync with external systems

## Key Features

- **Dual-pane interface** with synchronized PDF viewer and XML editor
- **AI-powered extraction** supporting multiple extraction engines
- **Version management** with branching, merging, and comparison tools  
- **Schema validation** with automatic TEI compliance checking
- **Access control** with document ownership and permission management
- **Collection organization** for managing document sets
- **WebDAV synchronization** for external system integration
- **Revision tracking** with detailed change documentation

## Target Use Cases

- Creating gold standard datasets for reference extraction research
- Manual validation and correction of AI-extracted bibliographic data
- Collaborative annotation of legal and humanities literature
- Training data preparation for machine learning models
- Quality assurance for large-scale digitization projects

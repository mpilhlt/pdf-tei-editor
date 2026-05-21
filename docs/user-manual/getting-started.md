# Getting Started

Welcome to the PDF-TEI Editor! This guide will help you get started with the application.

## What is the PDF-TEI Editor?

The PDF-TEI Editor is a specialized tool for creating and editing TEI (Text Encoding Initiative) XML documents from PDF sources. It provides a three-panel interface that allows you to view PDF documents alongside their TEI markup, with tools for extraction, editing, validation, and version management.

## First Login

The PDF-TEI Editor requires user authentication to access documents and manage permissions.

### Logging In

When you first access the application, you'll be automatically prompted to log in. Each browser tab maintains its own session, so you can have multiple sessions open with different users (or the same user) if needed.

## Main Interface

After logging in, you'll see the main two-panel interface:

- **Left Panel**: PDF document viewer
- **Right Panel**: XML editor with syntax highlighting and validation


See [Interface Overview](interface-overview.md) for detailed information about the interface.

## Basic Workflow

A typical workflow in the PDF-TEI Editor involves:

1. **Select or load a PDF** - Choose a document from the file selector or upload a new one
2. **Extract TEI** - Use automatic extraction to create initial TEI markup (see [Extraction Workflow](extraction-workflow.md))
3. **Save your personal version**: Depending on your project's workflow, you either work on the extracted document directly or create your own personal version. Keeping the original extraction unaltered and editing a copy is recommended particularly in scenarios with multiple annotators.
4. **Edit & Validate** - Refine the TEI markup using the XML editor (see [Editing Workflow](editing-workflow.md)). The application automatically validates and saves the document content after each change.
5. **Save a revision record** - Save the state of the document and what you have changed as a [revision record](#revisions) that is included in the TEI document header. This records your contribution to the annotation and leaves and makes it easy to attribute changes to individual annotators. This step also allows to move the document status within the [document lifecycle](#document-status) defined by your annotation project.
6. **Review** - The reviewers then check your annotations and mark gold standard files when ready for production

## Key Concepts

The application uses a number of concepts in its user interface that need to be clarified. 

### Collections

Documents are organized into "collections" which are shown in the "Collections & Files" Drawer and the Collection dropdown in the toolbar. Access to collections is granted by administrators via the groups users belong to. A typical use case for collections is for batches of documents which need to be edited in one round of annotations.

### Variants

The model "variant" denotes a particular XML schema or specialized use case that acts a filter for all the TEI documents that belong to a particular PDF. This can mean different things for specific extraction backends. For example, [Grobid](https://grobid.readthedocs.io) works with a number of different models which all need a particular XML annotation schema, each constituting a "variant" in the context of this application. 

### Versions, Artifacts, and "Gold"

For each PDF and variant, a number of "versions" of the TEI annotation can exist, also called "artifacts" since they are edited manually. Typically, the first version is the extraction as returned by the extraction backend. This version should not be edited but be kept to be able to compare annotations against it. It can be deleted safely later. In a mulit-annotator setup, each annotator should create their own version (this is enforced in [owner-based mode](./access-control.md#owner-based-mode)). Of all the versions of a variant, one can be assigned to be the "gold" version, i.e. the candidate to be included in the final Gold Standard dataset. This documentation uses the following conceptual convention: all TEI annotations of a PDF are called "artifacts", all annotations of a specific variant that are not "gold" are "versions", and the Gold Standard version is the "gold".  

### Revisions

Each annotation version contains information on the document revisions, i.e. TEI `<change>` elements that record who has made which change on the document. Annotators save a revision whenever they have finished a chunk of work and/or change the [status](#document-status) of the document.

### Document Status

A TEI annotation workflow typically specifies a lifecycle that moves from extraction to publication. The different lifecycle stages are called "status" in this app. The default status  are: extraction, unfinished, draft, checked, in-review, approved, candidate, and published. A status higher than "checked" can only be set by users having the "reviewer" role. The project workflow needs to specify how the status values are used. They are fully configurable by the administrator. 

## Next Steps

- **[Interface Overview](interface-overview.md)** - Learn about the interface components
- **[Extraction Workflow](extraction-workflow.md)** - Extract TEI from PDF documents
- **[Editing Workflow](editing-workflow.md)** - Edit and validate TEI markup
- **[Collection Management](collection-management.md)** - Organize your documents


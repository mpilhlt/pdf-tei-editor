# Collection Management

Collections in the PDF-TEI Editor help organize documents into logical groups for better project management, access control, and workflow organization.

## Understanding Collections

### What Are Collections?
Collections are organizational containers that group related documents together:
- **Project-Based**: Documents for specific research projects
- **Thematic Groups**: Documents by subject, period, or type
- **Processing Stages**: Documents at different stages of processing
- **Institutional**: Documents by source institution or department
- **User Collections**: Personal document collections

### Collection Hierarchy
- **Root Collections**: Top-level organizational units
- **Nested Organization**: Collections can contain sub-collections
- **Cross-Collection Access**: Documents can be referenced across collections
- **Default Collection**: New documents go to `__inbox` by default

## Viewing Collections

### Collection Display
Collections are visible in several places:
- **PDF Dropdown**: Shows collection structure in document selection
- **Document Information**: Current document's collection is displayed
- **Extraction Dialog**: Collection selection during extraction process
- **Move Files Dialog**: Available destination collections

### Collection Information
Each collection displays:
- **Collection Name**: Human-readable collection identifier
- **Document Count**: Number of documents in the collection
- **Access Level**: Your permission level for the collection
- **Description**: Purpose and scope of the collection (if available)

## Moving Documents Between Collections

### Move Files Tool (<!-- <sl-icon name="folder-symlink"></sl-icon> -->)
1. **Access Move Dialog**: Click the <!-- <sl-icon name="folder-symlink"></sl-icon> --> button in the Document toolbar section
2. **Select Target Collection**: Choose destination collection from dropdown
3. **Create New Collection**: Option to create a new collection if needed
4. **Confirm Move**: Documents and related files are moved to the new collection

### Move Dialog Features
- **Collection Selection**: Dropdown showing all accessible collections
- **New Collection Creation**: Create collections on-the-fly during move operations
- **Permission Validation**: Only shows collections you have write access to
- **Batch Operations**: Move multiple related files together

## Collection Access Control

### Collection Permissions
Collections inherit and extend document-level permissions:
- **Collection Owners**: Full control over collection and all documents
- **Contributors**: Can add documents and modify existing ones
- **Viewers**: Read-only access to collection contents
- **Restricted Access**: Limited access to specific document subsets

### Permission Inheritance
- **Default Permissions**: New documents inherit collection permissions
- **Override Capability**: Document-specific permissions can override collection settings
- **Cascading Changes**: Collection permission changes affect contained documents
- **Access Coordination**: Permissions coordinate with user roles and groups

## Working with Collections

### Document Organization Strategies

#### By Research Project
- **Project Alpha**: All documents related to specific research
- **Comparative Studies**: Documents for comparative analysis
- **Historical Periods**: Documents organized by time period
- **Geographic Regions**: Documents organized by location or jurisdiction

#### By Processing Stage
- **`__inbox`**: Newly uploaded documents awaiting processing
- **`in_progress`**: Documents currently being processed
- **`under_review`**: Documents awaiting quality control
- **`completed`**: Finished documents ready for publication

#### By Document Type
- **`legal_cases`**: Court decisions and legal opinions
- **`academic_papers`**: Research articles and academic publications
- **`legislation`**: Laws, regulations, and statutes
- **`commentaries`**: Legal and academic commentaries

### Collection Workflow Examples

#### Research Project Setup
1. **Create Project Collection**: Set up collection for new research project
2. **Configure Permissions**: Set appropriate access for team members
3. **Upload Source Documents**: Add PDFs to the collection
4. **Process Documents**: Run extraction and validation workflows
5. **Organize Results**: Move processed documents to appropriate sub-collections

#### Quality Control Pipeline
1. **Intake (`__inbox`)**: New documents arrive in inbox collection
2. **Initial Processing**: Move documents to `processing` collection for extraction
3. **Review Stage**: Move to `review` collection for quality control
4. **Final Collection**: Move completed documents to appropriate final collections

## Collection-Level Operations

### Bulk Operations
When working with collections, you can:
- **Batch Processing**: Run extraction on multiple documents simultaneously
- **Bulk Validation**: Validate all documents in a collection
- **Permission Updates**: Change access permissions for entire collections
- **Export Collections**: Download all documents from a collection
- **Synchronization**: Sync entire collections with external systems

### Collection Maintenance
- **Cleanup Operations**: Remove obsolete or duplicate documents
- **Reorganization**: Restructure collections as projects evolve
- **Archive Management**: Move old collections to archive storage
- **Statistics and Reporting**: Generate reports on collection contents and activity

## Integration with Other Features

### Extraction Process
- **Target Collection**: Choose destination collection during extraction
- **Collection Templates**: Use collection-specific extraction templates
- **Workflow Integration**: Collections integrate with extraction pipelines
- **Quality Standards**: Collections can enforce specific quality requirements

### Synchronization
- **WebDAV Integration**: Sync collections with external repositories
- **Selective Sync**: Sync only specific collections or subsets
- **Conflict Resolution**: Handle conflicts in collection-level synchronization
- **Backup Strategy**: Maintain collection backups in external systems

### Access Control Integration
- **User Groups**: Collections can be associated with user groups
- **Role-Based Access**: Different roles have different collection access
- **Project Permissions**: Collections coordinate with project-based permissions
- **Institutional Access**: Collections can reflect institutional boundaries

## Best Practices

### Collection Design
- **Logical Organization**: Structure collections to match workflow needs
- **Clear Naming**: Use descriptive, consistent collection names
- **Appropriate Granularity**: Balance between too many and too few collections
- **Future Planning**: Design collections to accommodate growth

### Permission Management
- **Principle of Least Privilege**: Grant minimum necessary access
- **Regular Review**: Periodically review and update collection permissions
- **Team Coordination**: Coordinate collection access with team needs
- **Documentation**: Document collection purpose and access policies

### Maintenance Workflow
- **Regular Cleanup**: Remove obsolete documents and empty collections
- **Performance Monitoring**: Monitor collection performance and storage usage
- **Backup Verification**: Ensure collection backups are current and complete
- **User Training**: Train team members on collection organization principles

## Troubleshooting Collection Issues

### Common Problems
- **Permission Denied**: Cannot access or modify collections
- **Move Failures**: Documents fail to move between collections
- **Sync Conflicts**: Collection synchronization encounters conflicts
- **Missing Documents**: Documents disappear after collection operations

### Resolution Steps
1. **Verify Permissions**: Check your access level for source and target collections
2. **Check Dependencies**: Ensure no documents are locked or in use during moves
3. **Resolve Conflicts**: Address synchronization conflicts manually
4. **Contact Administration**: Escalate persistent collection issues to system administrators
5. **Backup Recovery**: Restore from backup if documents are lost during operations
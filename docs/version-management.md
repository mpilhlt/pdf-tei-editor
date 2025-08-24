# Version Management

The PDF-TEI Editor provides comprehensive version management capabilities, allowing you to create, compare, and manage multiple versions of your TEI documents.

## Understanding Document Versions

### Version Types
- **Gold Standard**: The authoritative, fully verified version
- **Working Versions**: In-progress versions with ongoing edits
- **Extraction Results**: Versions created from AI extraction processes
- **Collaborative Versions**: Versions created by different team members

### Version Hierarchy
Documents can have:
- **Main Version**: The primary document version
- **Branches**: Alternative versions for different purposes
- **Revisions**: Saved snapshots of work in progress

## Creating New Versions

### Copy Current Version (<sl-icon name="copy"></sl-icon>)
1. **Click Copy Button**: Use the <sl-icon name="copy"></sl-icon> button in the Document toolbar section
2. **Version Details Dialog**: Fill in version information:
   - **Version Name**: Descriptive name for the new version
   - **Person Name**: Your name or editor identifier  
   - **Person ID**: Unique identifier (if applicable)
   - **Edition Note**: Description of changes or purpose
3. **Create Version**: Click Submit to create the new version

### Automatic Version Creation
Versions are automatically created during:
- **AI Extraction**: New extractions create separate versions
- **Merge Operations**: Merging changes creates new versions
- **Import Operations**: Uploaded files become new versions

## Version Selection and Navigation

### XML Version Dropdown
- **Current Version**: Shows the currently loaded version
- **Available Versions**: Dropdown lists all available versions
- **Gold Standard**: Special marking for the authoritative version
- **Switch Versions**: Click any version to load it

### Version Information Display
Each version shows:
- **Version Name**: Descriptive identifier
- **Creation Date**: When the version was created
- **Creator**: Who created this version
- **Status**: Current processing status
- **Permissions**: Access level for the version

## Version Comparison

### Compare with Version Dropdown  
1. **Select Comparison Target**: Choose a version to compare against current version
2. **Comparison View**: Interface shows differences between versions
3. **Side-by-Side Display**: Changes are highlighted in both versions

### Difference Navigation
- **Previous Diff**: Navigate to previous difference
- **Next Diff**: Navigate to next difference  
- **Difference Highlighting**: Added, removed, and modified content is color-coded
- **Context Display**: See surrounding context for each change

## Merging Versions

### Merge Process
When comparing versions, you can:
1. **Review Changes**: Examine each difference carefully
2. **Accept Changes**: <sl-icon name="check"></sl-icon> Accept individual changes from the comparison version
3. **Reject Changes**: <sl-icon name="x"></sl-icon> Reject changes and keep current version content
4. **Bulk Operations**: Accept or reject all changes at once

### Merge Strategies
- **Selective Merge**: Choose specific changes to incorporate
- **Complete Merge**: Accept all changes from source version
- **Manual Resolution**: Edit content to resolve conflicts manually

## Version Metadata Management

### TEI Header Updates
Version creation automatically updates:
- **Edition Statement**: Records the new edition information
- **Responsibility Statement**: Documents who made changes
- **Revision Description**: Tracks change history
- **Processing Instructions**: Notes about extraction or editing processes

### Change Documentation
Each version maintains:
- **Change Log**: Detailed record of modifications
- **Attribution**: Who made specific changes
- **Timestamps**: When changes were made
- **Change Type**: Nature of modifications (extraction, manual edit, merge, etc.)

## Version Workflow Examples

### Research Workflow
1. **Start with AI Extraction**: Create initial version from PDF
2. **Manual Verification**: Create working version for corrections
3. **Collaborative Review**: Share version for team review
4. **Merge Feedback**: Incorporate reviewer suggestions
5. **Create Gold Standard**: Finalize authoritative version

### Quality Control Workflow  
1. **Multiple Extractors**: Run different AI models to create multiple versions
2. **Compare Results**: Use version comparison to identify differences
3. **Best Practices Merge**: Combine the best elements from each version
4. **Validation**: Verify merged version against original PDF
5. **Approval**: Mark final version as gold standard

## Version Permissions and Access

### Version-Level Permissions
- **Owner Control**: Version creators control access
- **Inherited Permissions**: Versions can inherit document-level permissions
- **Override Capabilities**: Specific versions can have different access rules

### Collaborative Versioning
- **Branch Protection**: Prevent unauthorized changes to important versions
- **Merge Permissions**: Control who can merge versions
- **Review Workflow**: Require approval for version changes

## Best Practices

### Naming Conventions
- **Descriptive Names**: Use clear, descriptive version names
- **Date Stamps**: Include dates for chronological tracking
- **Purpose Indicators**: Note the purpose (e.g., "manual-review", "ai-extraction")
- **Stage Markers**: Indicate processing stage (e.g., "draft", "reviewed", "final")

### Version Management Strategy
- **Regular Saving**: Create versions at meaningful milestones
- **Change Documentation**: Always document what changed and why
- **Team Coordination**: Communicate version changes to collaborators
- **Backup Strategy**: Maintain multiple versions as backups

### Performance Considerations
- **Version Cleanup**: Periodically archive or delete obsolete versions
- **Storage Management**: Monitor storage usage for large document sets
- **Access Optimization**: Organize versions for efficient access

## Troubleshooting Version Issues

### Common Problems
- **Version Conflicts**: Multiple users editing the same version
- **Merge Errors**: Conflicts during version merging
- **Permission Issues**: Access problems with specific versions
- **Missing Versions**: Versions disappearing or becoming inaccessible

### Resolution Steps
1. **Check Permissions**: Verify you have access to all relevant versions
2. **Coordinate with Team**: Communicate with other editors about version status
3. **Backup Recovery**: Restore from backup if versions are lost
4. **Manual Resolution**: Manually resolve conflicts when automatic merge fails
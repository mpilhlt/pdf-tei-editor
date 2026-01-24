# Document Access Control

The PDF-TEI Editor uses a layered access control system to manage who can view and edit documents.

## Access Control Layers

### 1. Collection-Based Access

Documents belong to collections, and users access documents through their group memberships. You can only see and edit documents in collections your groups have access to.

**Example:** If you belong to the "Editors" group which has access to the "Manuscripts" collection, you can see all documents in that collection.

### 2. Role-Based Restrictions

Your user role determines what operations you can perform:

| Role          | Capabilities                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| **User**      | View documents                                                                  |
| **Annotator** | View documents, create and edit version files                                   |
| **Reviewer**  | All annotator capabilities, plus edit gold standard files and promote versions  |
| **Admin**     | Full access to all documents and settings                                       |

### 3. Document-Level Permissions

Depending on how your system is configured, additional document-level permissions may apply.

## Access Control Modes

Your administrator configures one of three access control modes:

### Role-Based Mode (Default)

In this mode, access is determined by your role and the file type:

- **Gold standard files**: Only reviewers can edit
- **Version files**: Annotators and reviewers can edit
- **Viewing**: Everyone with collection access can view all documents

This is the simplest mode and works well for most teams.

### Owner-Based Mode

In this mode, documents can only be edited by their creator (owner):

- You can edit documents you created
- You can view documents created by others, but they are read-only
- To modify someone else's document, create your own version

When you open a document owned by someone else, you'll see a notification:
> "This document is owned by [username]. Create your own version to edit."

### Granular Mode

In this mode, document owners and reviewers can set per-document visibility and editability:

**Visibility options:**

- **Collection** (default): Visible to everyone with collection access
- **Owner**: Visible only to the owner (and reviewers)

**Editability options:**

- **Collection**: Editable by everyone with collection access
- **Owner** (default): Editable only by the owner

## Using Permission Controls

### Status Bar Switches (Granular Mode Only)

If your system uses granular mode and you own a document (or are a reviewer), you'll see toggle switches in the editor's status bar:

- **Visibility switch**: Toggle between "Visible to all" and "Visible to owner"
- **Editability switch**: Toggle between "Editable by all" and "Editable by owner"

Changes take effect immediately when you toggle a switch.

### Read-Only Indicators

When a document is read-only, you'll see an indicator in the status bar explaining why:

- "Read-only (gold file - reviewer role required)" - You need reviewer role to edit gold files
- "Read-only (version file - annotator role required)" - You need annotator role to edit versions
- "Read-only (owned by [username])" - The document's editability is set to owner-only

### Creating Your Own Version

If you cannot edit a document due to permissions, you can create your own version:

1. Open the document
2. Use the "Duplicate current document" to make your own verions
3. Your new version will be owned by you and you can edit it as you wish

## Document Ownership

### How Ownership Works

- **Initial upload**: The user who uploads a PDF becomes its owner
- **Extraction**: The user who runs extraction owns the resulting TEI file
- **New versions**: When you create a version, you become its owner
- **Gold files**: The user who creates or promotes a gold file becomes its owner

### Ownership and Deletion

Deletion permissions depend on the access control mode:

- **Role-based/Owner-based**: Only reviewers and document owners can delete files
- **Granular mode**: Follows editability settings (if you can edit, you can delete)

Legacy documents without an owner can only be deleted by reviewers and admins.

## Tips for Collaborative Editing

1. **Use versions**: Create versions to work on documents without affecting the original
2. **Communicate ownership**: When working in owner-based mode, coordinate with team members about who owns what
3. **Check permissions first**: If you can't edit, check the status bar for the reason
4. **Ask reviewers**: If you need to edit a protected document, ask a reviewer to adjust permissions

## Troubleshooting

### "I can't see any documents"

- Check that you're logged in
- Verify you belong to at least one group
- Ask your administrator to confirm your group has collection access

### "I can see a document but can't edit it"

- Check your role (annotators can edit versions, reviewers can edit gold files)
- In owner-based mode, check if you're the document owner
- In granular mode, check if editability is set to "owner"

### "The permission switches aren't showing"

- Permission switches only appear in granular mode
- You must be the document owner or a reviewer to see them
- Make sure a document is loaded in the editor

## For Administrators

To change the access control mode, modify the "access-control.mode" config setting.

See the [developer documentation](../development/access-control.md) for technical details.

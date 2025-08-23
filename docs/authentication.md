# Authentication and Login

The PDF-TEI Editor requires user authentication to access documents and manage permissions.

## Login Process

1. **Access the Application**: Navigate to your PDF-TEI Editor URL (e.g., `http://localhost:3001` for development)

2. **Login Dialog**: Upon first access, you'll see a login dialog with:
   - **Username** field
   - **Password** field  
   - **Login** button

3. **Enter Credentials**: 
   - Enter your assigned username
   - Enter your password
   - Click the **Login** button

4. **Successful Login**: After authentication:
   - The login dialog closes
   - An information dialog appears: "Load a PDF from the dropdown on the top left"
   - The toolbar becomes fully accessible with all features enabled

## User Interface After Login

Once logged in, you'll see the complete interface:

### Toolbar Sections
- **PDF**: Dropdown to select documents
- **XML file version**: Version management dropdown  
- **Compare with version**: Document comparison tools
- **Variant**: Document variant selection
- **Document**: File management actions (<!-- <sl-icon name="copy"></sl-icon> --> copy, <!-- <sl-icon name="cloud-upload"></sl-icon> --> upload, <!-- <sl-icon name="cloud-download"></sl-icon> --> download, <!-- <sl-icon name="trash3"></sl-icon> --> delete, <!-- <sl-icon name="save"></sl-icon> --> save, <!-- <sl-icon name="folder-symlink"></sl-icon> --> move)
- **TEI**: XML validation tools (<!-- <sl-icon name="check-circle"></sl-icon> --> validate, <!-- <sl-icon name="magic"></sl-icon> --> TEI wizard)
- **Sync**: File synchronization (<!-- <sl-icon name="arrow-repeat"></sl-icon> --> sync)
- **Extraction**: AI-powered extraction tools (<!-- <sl-icon name="filetype-pdf"></sl-icon> --> extract new, <!-- <sl-icon name="clipboard2-plus"></sl-icon> --> extract current, <!-- <sl-icon name="pencil-square"></sl-icon> --> edit instructions)

### Main Interface
- **Left Panel**: PDF viewer with navigation controls
- **Right Panel**: XML/TEI editor with syntax highlighting
- **Center Panel**: Floating navigation panel with node verification tools

## Session Management

- **Session Persistence**: Your login session is maintained across browser tabs and refreshes
- **Logout**: Use the logout button in the top-right toolbar to end your session
- **Auto-logout**: Sessions may expire after a period of inactivity

## User Roles and Permissions

Different users may have different access levels:
- **Read-only**: Can view documents but cannot edit
- **Editor**: Can edit documents they have permission to modify  
- **Owner**: Full access to owned documents including permission management
- **Admin**: System-wide administrative access

Your specific permissions will determine which features are available in the interface.

# RBAC Manager Plugin

## Administrator Guide

The RBAC Manager is available to admin users only. Open it via the **shield icon** in the application toolbar. The dialog has five tabs: **Users**, **Projects**, **Groups**, **Roles**, and **Collections**.

### Access Control Model

Access to documents flows through this hierarchy:

```text
User → Project membership → Collections listed in the project → Documents in those collections
```

A user can see and open documents only in collections that belong to at least one project the user is listed in. Users whose roles include `*` (wildcard) bypass project resolution and have access to all collections.

### Setting Up a New Project

1. Open the RBAC Manager and click the **Projects** tab.
2. Click **Add** to create a new project. Fill in:
   - **ID** — a short, URL-safe identifier (letters, numbers, hyphens, underscores).
   - **Name** — the human-readable display name.
   - **Description** — optional.
3. Save. The project appears in the list.
4. Select the project to open its detail form. Below the basic fields you will see two additional sections:
   - **Members** — add or remove usernames. Each listed user gains access to all collections in this project.
   - **Collections** — add or remove collection IDs. Use `*` as the sole entry to grant access to every collection (wildcard project).

### Setting Up a New Collection

1. Click the **Collections** tab.
2. Click **Add**. Fill in:
   - **ID** — URL-safe identifier, used as the directory name on disk.
   - **Name** — display label shown in dropdowns.
   - **Description** — optional.
3. Save. The collection exists but is not yet accessible to anyone.
4. Go back to **Projects** and add the new collection ID to the appropriate project's Collections list.

The `_inbox` collection is the system default for newly extracted documents. It should be included in at least one project so that users can see arriving documents.

### Managing Users

1. Click the **Users** tab.
2. Click **Add** to create a user. Required fields: **username** and **password**. Optional: **email**, **display name**.
3. Select an existing user to edit their details or reset their password.
4. The user detail form shows read-only **Groups** and **Projects** sections so you can quickly audit a user's access without switching tabs.
5. You cannot delete your own account.

### Managing Groups

Groups are named sets of users. They can be referenced in role assignments or used to bulk-manage access.

1. Click the **Groups** tab, then **Add**.
2. Fill in the group **ID** and **Name**.
3. After saving, select the group and use the **Members** section to add usernames.

### Managing Roles

Roles carry permission strings consumed by the application. Built-in roles (`admin`, `reviewer`, `annotator`) cannot be deleted.

1. Click the **Roles** tab to view or create roles.
2. A role with `*` in its permissions list grants unrestricted access.

### Per-Collection and Per-Project Config Overrides

Selecting a project or collection shows a **Config Overrides** section at the bottom of the form. These key/value pairs override the global application config for documents in that scope. Use them to, for example, enable a specific extraction variant or restrict the annotation lifecycle statuses for a particular collection.

Click **Add** in the Config Overrides section, enter the config key (auto-suggested from the global config) and its value, then **Save** the entity.

---

## Implementation Plan

Generic RBAC management plugin for visual administration of users, groups, roles, and collections with extensible entity-driven architecture.

### Phase 1: Core Infrastructure (MVP)

#### Step 1.1: Entity Schema System

- Create `app/src/modules/rbac/entity-schemas.js`
- Define declarative schemas for users and groups
- Add field type definitions and validation rules
- Export schema registry and accessor functions

#### Step 1.2: Dynamic Form Renderer

- Create `app/src/modules/rbac/form-renderer.js`
- Implement field type renderers (string, email, multiselect, etc.)
- Add form validation logic
- Return structured data from form inputs

#### Step 1.3: Entity Manager Component

- Create `app/src/modules/rbac/entity-manager.js`
- Implement generic CRUD operations
- Add error handling and optimistic updates
- Integrate with client API

#### Step 1.4: Main Plugin and UI

- Create `app/src/plugins/rbac-manager.js`
- Create `app/src/templates/rbac-manager-dialog.html`
- Implement dialog with tab navigation
- Add entity list view (left panel)
- Add dynamic form view (right panel)
- Wire up save/cancel/delete actions

#### Step 1.5: Backend API Integration

- Verify existing endpoints or create new ones
- Add client API methods for RBAC operations
- Test CRUD operations with backend

#### Step 1.6: Toolbar Integration

- Add toolbar button to open RBAC manager
- Add permission check (admin only)
- Register plugin in app.js

### Phase 2: Full Entity Support

#### Step 2.1: Extend Entity Schemas

- Add role entity schema
- Add collection entity schema
- Update relationship definitions

#### Step 2.2: Relationship Management

- Implement relationship editing UI
- Add validation for circular dependencies
- Handle cascading updates

#### Step 2.3: Search and Filter

- Add search input to entity lists
- Implement client-side filtering
- Add sort options

### Phase 3: Advanced Features

#### Step 3.1: Bulk Operations

- Multi-select in entity lists
- Bulk edit functionality
- Bulk delete with confirmation

#### Step 3.2: Import/Export

- Export entities to JSON
- Import with validation
- Merge strategies

#### Step 3.3: Audit Trail

- Display modification history
- Show who modified what
- Integration with backend audit system

## Progress Log

### 2025-01-28 - Phase 1 Core Infrastructure (Steps 1.1-1.4 Complete)

**Entity Schema System** ([entity-schemas.js](../../app/src/modules/rbac/entity-schemas.js)):

- Declarative schema definitions for user, group, role, and collection entities
- Field type system supporting string, email, password, textarea, multiselect, checkbox
- Built-in validation including required fields, email format, custom validators
- Relationship definitions for entity associations
- Helper functions: `getEntitySchema()`, `validateEntity()`, `createDefaultEntity()`

**Dynamic Form Renderer** ([form-renderer.js](../../app/src/modules/rbac/form-renderer.js)):

- Generates Shoelace-based forms from entity schemas
- Field renderers for all supported types with proper styling
- Multiselect fields rendered as checkbox groups with wildcard support
- Form data extraction with proper type handling
- Validation error display and clearing

**Entity Manager** ([entity-manager.js](../../app/src/modules/rbac/entity-manager.js)):

- Generic CRUD operations for all entity types
- Client-side caching for performance
- Validation before create/update operations
- Search and filter capabilities
- API endpoint mapping (users, groups, roles, collections)

**Main Plugin** ([rbac-manager.js](../../app/src/plugins/rbac-manager.js)):

- Complete dialog UI with tab navigation
- Entity list with search filtering
- Dynamic form rendering based on selected entity
- Create/edit/delete operations with proper state management
- Admin-only access control
- Event handling for all user interactions

**UI Templates**:

- [rbac-manager-dialog.html](../../app/src/templates/rbac-manager-dialog.html): Split-panel dialog with tabs
- [rbac-manager-button.html](../../app/src/templates/rbac-manager-button.html): Toolbar button

**Integration**:

- Plugin registered in [plugins.js](../../app/src/plugins.js)
- Button added to toolbar (admin users only)
- Uses existing client API infrastructure

### 2025-01-28 - Backend API Integration (Step 1.5 Complete)

**Backend API Integration**:

- Created [users.py](../../fastapi_app/routers/users.py): Full CRUD endpoints for user management
- Created [groups.py](../../fastapi_app/routers/groups.py): Full CRUD endpoints for group management
- Created [roles.py](../../fastapi_app/routers/roles.py): Full CRUD endpoints for role management
- Added helper functions to [group_utils.py](../../fastapi_app/lib/group_utils.py): `create_group()`
- Added helper functions to [role_utils.py](../../fastapi_app/lib/role_utils.py): `find_role()`, `role_exists()`, `create_role()`
- Registered all routers in [main.py](../../fastapi_app/main.py)
- All endpoints require admin authentication
- Consistent response models and error handling

**API Endpoints Created**:

- `GET/POST /api/v1/users` - List/create users
- `GET/PUT/DELETE /api/v1/users/{username}` - Get/update/delete specific user
- `GET/POST /api/v1/groups` - List/create groups
- `GET/PUT/DELETE /api/v1/groups/{group_id}` - Get/update/delete specific group
- `GET/POST /api/v1/roles` - List/create roles
- `GET/PUT/DELETE /api/v1/roles/{role_id}` - Get/update/delete specific role

**Phase 1 MVP Complete**:

The RBAC Manager plugin is now fully functional with:

1. ✅ Entity schema system for all RBAC entities
2. ✅ Dynamic form generation from schemas
3. ✅ Generic entity manager with CRUD operations
4. ✅ Complete UI with tab navigation and split panels
5. ✅ Backend API endpoints for all entity types
6. ✅ Admin-only access control
7. ✅ Search and filter in entity lists
8. ✅ Form validation and error display

### 2025-01-28 - API Tests Created and Fixed

**Generic RBAC API Tests** ([rbac_crud.test.js](../../tests/api/v1/rbac_crud.test.js)):

- Created generic test suite using entity schemas
- Tests all CRUD operations for users, groups, and roles
- Edge case tests: self-deletion prevention, built-in role protection, password hashing
- Permission tests: admin-only access verification
- 22 test cases covering all RBAC entity types
- Collections excluded (managed through different API)

**Backend Fixes**:

- Fixed [users.py](../../fastapi_app/routers/users.py), [groups.py](../../fastapi_app/routers/groups.py), [roles.py](../../fastapi_app/routers/roles.py):
  - Added `Depends(get_current_user)` to `require_admin()` functions
  - Proper FastAPI dependency injection for authentication
- Tests now use existing helpers from [test-auth.js](../../tests/api/helpers/test-auth.js)
- Session header corrected to `X-Session-Id` (case-sensitive)

**Test Results**: ✅ All 22 tests passing

**Next Steps**:

- Manual testing in browser with admin user
- Error handling refinement based on real usage
- Phase 2: Enhanced relationship management UI
- Phase 2: Bulk operations and import/export

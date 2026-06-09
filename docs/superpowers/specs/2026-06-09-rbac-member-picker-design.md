# RBAC Member Picker Widget — Design Spec

**Date**: 2026-06-09
**Branch**: feature/projects

## Overview

Replace the checkbox-based multiselect for group/project membership with a reusable interactive table widget. The widget matches the config-override card pattern (immediate saves, inline add-row with searchable dropdown) and is used in three places:

- **Groups tab**: add/remove users directly (replaces read-only display + "edit in Users tab" note)
- **Projects tab**: add/remove individual users or entire groups as members (replaces `members` checkbox multiselect)
- **Users tab**: read-only display of which groups the user belongs to (replaces `groups` checkbox multiselect)

---

## 1. New Module: `createMemberPicker`

**File**: `app/src/modules/rbac/member-picker.js`

### Factory function signature

```javascript
/**
 * @typedef {object} MemberPickerColumn
 * @property {string} key - Property name on each item object
 * @property {string} label - Column header text
 * @property {boolean} [monospace] - Render value in monospace font
 */

/**
 * @typedef {object} MemberPickerOption
 * @property {string} value - The ID value to pass to onAdd
 * @property {string} primaryLabel - Main display text (also used for filtering)
 * @property {string} [secondaryLabel] - Smaller secondary text shown in dropdown
 * @property {string} [optionGroup] - Group header label in dropdown (e.g. 'Users', 'Groups')
 */

/**
 * @typedef {object} MemberPickerHandle
 * @property {HTMLElement} element - The rendered section element
 * @property {function(object[]): void} setItems - Replace the displayed items
 * @property {function(MemberPickerOption[]): void} setAvailable - Replace available options
 * @property {function(boolean): void} setDisabled - Enable/disable the widget
 */

/**
 * Create a member picker widget.
 * @param {object} options
 * @param {string} options.label
 * @param {MemberPickerColumn[]} options.columns
 * @param {object[]} options.items
 * @param {MemberPickerOption[]} options.availableOptions
 * @param {function(string): Promise<void>} options.onAdd
 * @param {function(object): Promise<void>} options.onRemove
 * @param {boolean} [options.disabled]
 * @returns {MemberPickerHandle}
 */
export function createMemberPicker(options) { ... }
```

### Rendered HTML structure

```html
<div class="member-picker-section" style="[card style matching entityConfigSection]">
  <div style="header row: flex, space-between">
    <h4 style="[matching section header style]">[label]</h4>
    <sl-button size="small" variant="default" name="addMemberBtn">
      <sl-icon slot="prefix" name="plus"></sl-icon>Add
    </sl-button>
  </div>

  <!-- Add row (injected at top when Add is clicked, removed on confirm/cancel) -->
  <div class="add-member-row" style="flex, gap 0.5rem">
    <sl-input size="small" placeholder="Filter..." style="flex: 0 0 40%">
    <sl-select size="small" placeholder="Select..." style="flex: 1">
      [sl-option per available option, optionally grouped with optgroup labels]
    </sl-select>
    <sl-button size="small" variant="primary" disabled>Add</sl-button>
    <sl-icon-button name="x" label="Cancel">
  </div>

  <!-- Table or empty state -->
  <table style="[matching #renderGroupMembers table style]">
    <thead><tr>[column headers] | [empty action header]</tr></thead>
    <tbody>
      <tr>
        <td>[item[col.key] for each column]</td>
        ...
        <td><sl-icon-button name="trash" label="Remove"></td>
      </tr>
    </tbody>
  </table>
  <!-- OR when empty: -->
  <div style="neutral-500, 0.8em">No [label.toLowerCase()]</div>
</div>
```

### Filtering behaviour

The `sl-input` filters which `sl-option` elements are shown in the `sl-select`. On `sl-input` event, iterate all `sl-option` children and toggle `style.display` based on whether `primaryLabel` or `secondaryLabel` includes the filter string (case-insensitive). The confirm button enables once a value is selected in `sl-select`.

### State

The widget holds its own `items` and `availableOptions` arrays internally. `setItems`, `setAvailable`, and `setDisabled` update these and re-render the table (or add-row dropdown respectively). The widget does not cache API state — the caller is responsible for passing fresh data after each mutation.

### optionGroup support

When options include `optionGroup`, the `sl-select` renders a visual separator and a non-selectable label row before each group. Shoelace `sl-select` only renders `sl-option` children; group headers are implemented as a disabled `sl-option` styled with `font-weight: 600; color: var(--sl-color-neutral-600)` preceded by an `sl-divider` (except before the first group). Groups appear in the order they first appear in the options array. Group header options have a sentinel `value` (e.g. `''`) and `disabled` attribute so they cannot be selected.

---

## 2. Groups Tab

### Changes to `rbac-manager.js`

- Replace `#renderGroupMembers(groupId)` with `#renderGroupMembersWidget(groupId)`
- On first call for a given group: create the picker via `createMemberPicker`, store the handle on `this.#groupMemberPicker`
- On subsequent calls (re-render): call `handle.setItems(...)` and `handle.setAvailable(...)`
- The picker element is inserted into `[name="groupMembersList"]` once; subsequent renders update it in place

**availableOptions**: all users whose `groups[]` does NOT include `groupId`

- `value`: `user.username`
- `primaryLabel`: `user.username`
- `secondaryLabel`: `user.fullname`
- No `optionGroup` (single source)

**columns**: `[{ key: 'username', label: 'Username', monospace: true }, { key: 'fullname', label: 'Full Name' }]`

**onAdd(username)**:

```text
user = entityManagers.user.findById(username)
updatedGroups = [...(user.groups || []), groupId]
await entityManagers.user.update(username, { ...user, groups: updatedGroups })
re-render widget with updated data
```

**onRemove(item)**: existing `#removeUserFromGroup` logic, then re-render widget

### Changes to `rbac-manager-dialog.html`

Remove the `<p>` note from `groupMembersSection`. The widget renders its own header. The section becomes:

```html
<div name="groupMembersSection" style="display:none; [card styles]">
  <div name="groupMembersList">
    <!-- createMemberPicker element inserted here -->
  </div>
</div>
```

---

## 3. Projects Tab

### New method `#renderProjectMembersSection(projectId)`

Called from `#showEntityForm()` when `currentEntityType === 'project'` and `!isNewEntity`.

Mirrors the structure of `#renderGroupMembersWidget` — creates/updates a picker stored on `this.#projectMemberPicker`.

The picker element is inserted into `[name="projectMembersList"]`.

**availableOptions**: two groups

1. Users not already in `project.members`:
   - `value`: `user.username`
   - `primaryLabel`: `user.username`
   - `secondaryLabel`: `user.fullname`
   - `optionGroup`: `'Users'`

2. All groups (regardless of membership — selecting a group expands it):
   - `value`: `group.id`
   - `primaryLabel`: `group.id`
   - `secondaryLabel`: `group.name`
   - `optionGroup`: `'Groups'`

**columns**: `[{ key: 'username', label: 'Username', monospace: true }, { key: 'fullname', label: 'Full Name' }]`

**onAdd(value)**:

```text
project = entityManagers.project.findById(projectId)
currentMembers = [...(project.members || [])]

if value is a group id (i.e. entityManagers.group.findById(value) exists):
  usersInGroup = entityManagers.user.getAll().filter(u => u.groups?.includes(value))
  newMembers = usersInGroup.filter(u => !currentMembers.includes(u.username)).map(u => u.username)
  updatedMembers = [...currentMembers, ...newMembers]
else:
  updatedMembers = [...currentMembers, value]  // value is a username

await entityManagers.project.update(projectId, { ...project, members: updatedMembers })
reload project in entityManagers cache
re-render widget
```

**onRemove(item)**:

```text
project = entityManagers.project.findById(projectId)
updatedMembers = (project.members || []).filter(m => m !== item.username)
await entityManagers.project.update(projectId, { ...project, members: updatedMembers })
re-render widget
```

### Template changes for Projects tab

Add `projectMembersSection` alongside `groupMembersSection`:

```html
<div name="projectMembersSection" style="display:none; [same card styles as groupMembersSection]">
  <div name="projectMembersList">
    <!-- createMemberPicker element inserted here -->
  </div>
</div>
```

### Schema changes for Projects tab

`project.members` field gains `excludeFromForm: true`:

```javascript
{
  name: 'members',
  type: 'multiselect',
  label: 'Members',
  options: 'user',
  helpText: 'Users with access to this project',
  excludeFromForm: true   // managed by member picker widget
}
```

---

## 4. Users Tab — Read-Only Groups Display

### New method `#renderUserGroupsSection(username)`

Called from `#showEntityForm()` when `currentEntityType === 'user'` and `!isNewEntity`.

Renders a read-only table of groups the user belongs to, inserted into `[name="userGroupsList"]`.

Table columns: Group ID (monospace) | Group Name. No action buttons.

Empty state: "No groups assigned."

### Template changes for Users tab

Add `userGroupsSection` alongside the other sections:

```html
<div name="userGroupsSection" style="display:none; [same card styles]">
  <h4 style="[matching header style]">Groups</h4>
  <div name="userGroupsList">
    <!-- read-only table inserted here -->
  </div>
</div>
```

### Schema changes for Users tab

`user.groups` field gains `excludeFromForm: true`:

```javascript
{
  name: 'groups',
  type: 'multiselect',
  label: 'Groups',
  options: 'group',
  helpText: 'Groups this user belongs to',
  excludeFromForm: true   // displayed read-only; managed from Groups tab
}
```

---

## 5. Form Renderer + Schema Changes

### `EntityField` typedef

Add `excludeFromForm?: boolean` to the typedef in `entity-schemas.js`.

### `renderEntityForm` in `form-renderer.js`

Skip fields where `field.excludeFromForm === true`:

```javascript
for (const field of schema.fields) {
  if (field.hidden || field.excludeFromForm) continue
  // ... render field
}
```

### `extractFormData` in `form-renderer.js`

Skip fields where `field.excludeFromForm === true`:

```javascript
for (const field of schema.fields) {
  if (field.hidden || field.excludeFromForm) continue
  // ... extract field value
}
```

This ensures `groups` and `members` are never included in form save data, so the Save button cannot inadvertently overwrite membership arrays managed by the pickers.

---

## 6. `#showEntityForm` Orchestration Changes

In `rbac-manager.js`, `#showEntityForm()` currently conditionally shows/hides `entityConfigSection` and `groupMembersSection`. Extend it to also handle the two new sections:

```text
projectMembersSection: shown when currentEntityType === 'project' && !isNewEntity
userGroupsSection:     shown when currentEntityType === 'user'    && !isNewEntity
```

When `isNewEntity` is true for project or user, the section is hidden (or the picker is shown disabled with a "Save first to manage members" note for projects; users never have a picker, just read-only).

For new users: `userGroupsSection` is hidden entirely (nothing to show until saved).

---

## 7. Section Visibility Summary

| Section | Trigger |
| --- | --- |
| `entityConfigSection` | collection or project, not new |
| `groupMembersSection` | group, not new |
| `projectMembersSection` | project, not new |
| `userGroupsSection` | user, not new |

---

## 8. Files Changed

| File | Change |
| --- | --- |
| `app/src/modules/rbac/member-picker.js` | **new** — reusable widget factory |
| `app/src/modules/rbac/entity-schemas.js` | add `excludeFromForm` to `EntityField` typedef; flag `user.groups` and `project.members` |
| `app/src/modules/rbac/form-renderer.js` | skip `excludeFromForm` fields in render + extract |
| `app/src/plugins/rbac-manager.js` | replace `#renderGroupMembers`, add `#renderProjectMembersSection`, add `#renderUserGroupsSection`, update `#showEntityForm` orchestration, update `#setupDialogListeners` for new sections |
| `app/src/templates/rbac-manager-dialog.html` | add `projectMembersSection` and `userGroupsSection` divs; strip `<p>` from `groupMembersSection` |
| `app/src/templates/rbac-manager-dialog.types.js` | add typedefs for new named elements |

---

## Out of Scope

- Roles field on Users tab: unchanged (remains checkbox multiselect)
- Collections field on Projects tab: unchanged (remains checkbox multiselect)
- Wildcard `*` option: not included in member picker (was only meaningful for collections/roles)

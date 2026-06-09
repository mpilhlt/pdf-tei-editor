// AUTO-GENERATED from rbac-manager-dialog.html — do not edit
// Regenerate with: npm run build:ui-types

/**
 * @typedef {object} rbacManagerDialogPart
 * @property {HTMLDivElement & tabContainerPart} tabContainer
 * @property {HTMLDivElement & contentAreaPart} contentArea
 * @property {import('../ui.js').SlButton} closeBtn
 */

/**
 * @typedef {object} tabContainerPart
 * @property {import('../ui.js').SlButton} tabUser
 * @property {import('../ui.js').SlButton} tabProject
 * @property {import('../ui.js').SlButton} tabGroup
 * @property {import('../ui.js').SlButton} tabRole
 * @property {import('../ui.js').SlButton} tabCollection
 */

/**
 * @typedef {object} contentAreaPart
 * @property {HTMLDivElement & entityListPanelPart} entityListPanel
 * @property {HTMLDivElement & formPanelPart} formPanel
 */

/**
 * @typedef {object} entityListPanelPart
 * @property {HTMLElement} entityListTitle
 * @property {import('../ui.js').SlButton} addEntityBtn
 * @property {import('../ui.js').SlInput} searchInput
 * @property {HTMLDivElement} entityList
 */

/**
 * @typedef {object} formPanelPart
 * @property {HTMLDivElement & formHeaderPart} formHeader
 * @property {HTMLDivElement & formContainerPart} formContainer
 */

/**
 * @typedef {object} formHeaderPart
 * @property {HTMLElement} formTitle
 * @property {HTMLDivElement & formActionsPart} formActions
 */

/**
 * @typedef {object} formActionsPart
 * @property {import('../ui.js').SlButton} saveBtn
 * @property {import('../ui.js').SlButton} deleteBtn
 */

/**
 * @typedef {object} formContainerPart
 * @property {HTMLDivElement} emptyState
 * @property {HTMLDivElement & entityConfigSectionPart} entityConfigSection
 * @property {HTMLDivElement & groupMembersSectionPart} groupMembersSection
 * @property {HTMLDivElement & projectMembersSectionPart} projectMembersSection
 * @property {HTMLDivElement & userGroupsSectionPart} userGroupsSection
 */

/**
 * @typedef {object} entityConfigSectionPart
 * @property {import('../ui.js').SlButton} addConfigKeyBtn
 * @property {HTMLDivElement} entityConfigList
 */

/**
 * @typedef {object} groupMembersSectionPart
 * @property {HTMLDivElement} groupMembersList
 */

/**
 * @typedef {object} projectMembersSectionPart
 * @property {HTMLDivElement} projectMembersList
 */

/**
 * @typedef {object} userGroupsSectionPart
 * @property {HTMLDivElement} userGroupsList
 */

export {}

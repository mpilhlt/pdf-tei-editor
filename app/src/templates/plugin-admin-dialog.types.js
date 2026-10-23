// AUTO-GENERATED from plugin-admin-dialog.html — do not edit
// Regenerate with: npm run build:ui-types

/**
 * @typedef {object} pluginAdminDialogPart
 * @property {HTMLDivElement} summary
 * @property {HTMLElement & reloadBannerPart} reloadBanner
 * @property {HTMLElement & restartBannerPart} restartBanner
 * @property {import('../ui.js').SlTabGroup & tabsPart} tabs
 * @property {import('../ui.js').SlButton} closeBtn
 */

/**
 * @typedef {object} reloadBannerPart
 * @property {HTMLSpanElement} bannerText
 * @property {import('../ui.js').SlButton} reloadBtn
 */

/**
 * @typedef {object} restartBannerPart
 * @property {HTMLSpanElement} restartText
 * @property {import('../ui.js').SlButton} restartBtn
 */

/**
 * @typedef {object} tabsPart
 * @property {import('../ui.js').SlTab} installedTab
 * @property {import('../ui.js').SlTab} availableTab
 * @property {import('../ui.js').SlTabPanel & installedPanelPart} installedPanel
 * @property {import('../ui.js').SlTabPanel & availablePanelPart} availablePanel
 */

/**
 * @typedef {object} installedPanelPart
 * @property {import('../ui.js').SlInput} searchInput
 * @property {HTMLDivElement} statusChips
 * @property {HTMLDivElement} pluginList
 */

/**
 * @typedef {object} availablePanelPart
 * @property {import('../ui.js').SlInput} availableSearch
 * @property {import('../ui.js').SlButton} refreshBtn
 * @property {HTMLDivElement} availableNote
 * @property {HTMLDivElement} availableList
 */

export {}

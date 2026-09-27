// AUTO-GENERATED from document-rules-editor-dialog.html — do not edit
// Regenerate with: npm run build:ui-types

/**
 * @typedef {object} documentRulesEditorDialogPart
 * @property {HTMLDivElement} overrideRow
 * @property {import('../ui.js').SlInput} noteInput
 * @property {HTMLDivElement & textBodyPart} textBody
 * @property {HTMLDivElement & xmlBodyPart} xmlBody
 * @property {import('../ui.js').SlButton} newOverrideBtn
 * @property {import('../ui.js').SlButton} saveBtn
 * @property {import('../ui.js').SlButton} deleteBtn
 * @property {import('../ui.js').SlButton} resetBtn
 * @property {import('../ui.js').SlButton} closeBtn
 */

/**
 * @typedef {object} textBodyPart
 * @property {import('../ui.js').SlTabGroup & textTabsPart} textTabs
 */

/**
 * @typedef {object} textTabsPart
 * @property {import('../ui.js').SlTab} editTab
 * @property {import('../ui.js').SlTab} previewTab
 * @property {import('../ui.js').SlTabPanel & editPanelPart} editPanel
 * @property {import('../ui.js').SlTabPanel & previewPanelPart} previewPanel
 */

/**
 * @typedef {object} editPanelPart
 * @property {import('../ui.js').SlTextarea} textArea
 */

/**
 * @typedef {object} previewPanelPart
 * @property {HTMLDivElement} previewContent
 */

/**
 * @typedef {object} xmlBodyPart
 * @property {HTMLDivElement} xmlContainer
 */

export {}

/**
 * @file Frontend Extension: Reference Dialog
 * Reference implementation of a frontend extension that builds its UI from the
 * HTML templates in the plugin's templates/ directory:
 *
 * - templates/toolbar-button.html: toolbar button, created without a parent node
 *   and inserted by the extension, so updateUi() has to be called afterwards
 * - templates/dialog.html: dialog with a ${title} parameter, appended to document.body,
 *   which makes its named elements reachable through getDependency('ui')
 * - templates/reference-plugin.css: stylesheet added to the page before install()
 *
 * Top-level element names start with the plugin id in camelCase (referencePlugin...),
 * since all named elements share the global `ui` tree.
 *
 * @import { PluginContext } from '../../../../../app/src/modules/plugin-context.js'
 * @import { ApplicationState } from '../../../../../app/src/state.js'
 */

export default class ReferenceDialogExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'reference-plugin', deps: ['ui', 'ui-system'] });
  }

  static extensionPoints = ['reference-plugin.show'];

  /**
   * Creates the dialog and the toolbar button from the plugin's templates.
   * @param {ApplicationState} state - Initial application state
   */
  async install(state) {
    await super.install(state);

    // Appended to a parent: named elements are added to `ui` automatically
    this.createSingleFromTemplate('dialog', document.body, { title: 'Reference Plugin' });
    const ui = this.getDependency('ui');
    ui.referencePluginDialog.closeBtn.addEventListener('click', () => ui.referencePluginDialog.hide());

    // Created without a parent and inserted by the extension: update `ui` afterwards
    const button = this.createSingleFromTemplate('toolbar-button');
    button.addEventListener('click', () => this['reference-plugin.show']('Rendered from a plugin template'));
    ui.toolbar.add(button, 0, -1);
    this.getDependency('ui-system').updateUi();
  }

  /**
   * Extension point handler for `reference-plugin.show`: shows the dialog with a message.
   * Invoked by the toolbar button and via `app.invokePluginEndpoint('reference-plugin.show', [message])`.
   * @param {string} message - Text shown in the dialog
   * @returns {Promise<void>}
   */
  async ['reference-plugin.show'](message) {
    const dialog = this.getDependency('ui').referencePluginDialog;
    dialog.message.textContent = message;
    await dialog.show();
  }
}

/**
 * @file Frontend Extension: Hello World Test
 * Adds a test button that opens a Hello World dialog.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class HelloWorldExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'hello-world-test', deps: ['dialog'] });
  }

  static extensionPoints = ['hello-world-test.greet'];

  /**
   * @param {Object} state - Initial application state
   */
  async install(state) {
    await super.install(state);

    const button = document.createElement('sl-button');
    button.variant = 'text';
    button.size = 'small';
    button.innerHTML = '<sl-icon name="info-circle"></sl-icon>';
    button.title = 'Hello World Test';
    button.dataset.testId = 'hello-world-toolbar-btn';

    button.addEventListener('click', () => {
      this.getDependency('dialog').info('Hello World from frontend extension!');
    });

    this.getDependency('ui').toolbar.add(button, 0, -1);
  }

  /**
   * Custom endpoint — can be invoked by other plugins via 'hello-world-test.greet'.
   * @param {string} greeting
   * @returns {string}
   */
  greet(greeting) {
    this.getDependency('dialog').info(greeting || 'Hello!');
    return 'Greeting displayed';
  }
}

/**
 * @file Frontend Extension: Hello World Test
 * Adds a test button that opens a Hello World dialog.
 */

export const name = "hello-world-test";
export const description = "Adds Hello World button for testing";
export const deps = ['dialog'];

/**
 * Install the extension.
 * @param {Object} state - Initial application state
 * @param {Object} sandbox - Extension sandbox
 */
export function install(state, sandbox) {
  // Create toolbar button
  const button = document.createElement('sl-button');
  button.variant = 'text';
  button.size = 'small';
  button.innerHTML = '<sl-icon name="info-circle"></sl-icon>';
  button.title = 'Hello World Test';
  button.dataset.testId = 'hello-world-toolbar-btn';

  button.addEventListener('click', () => {
    sandbox.dialog.info('Hello World from frontend extension!');
  });

  // Add to toolbar
  sandbox.ui.toolbar.add(button, 0, -1);
}

/**
 * Custom endpoint - can be invoked by other plugins.
 * @param {string} greeting - Custom greeting text
 * @param {Object} sandbox
 * @returns {string}
 */
export function greet(greeting, sandbox) {
  sandbox.dialog.info(greeting || 'Hello!');
  return 'Greeting displayed';
}

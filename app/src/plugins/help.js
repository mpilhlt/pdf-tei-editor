/**
 * Help plugin that displays contextual help topics in a radial menu.
 * Other plugins can register help topics that appear when users click the help icon.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { helpWidgetPart } from '../templates/help-widget.types.js'
 */

import { Plugin } from '../modules/plugin-base.js';
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js';

/**
 * @typedef HelpTopic
 * @property {string} id - Unique topic identifier
 * @property {string} label - Topic display name
 * @property {string} icon - Shoelace icon name
 * @property {Function} callback - Handler when topic is selected
 */

// Register template at module level
await registerTemplate('help-widget', 'help-widget.html');

class HelpPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'help', deps: [] });
  }

  /** @type {HTMLElement & helpWidgetPart} */
  #ui = null

  /** @type {Array<HelpTopic>} */
  topics = [];

  /** @type {boolean} */
  menuVisible = false;

  /** @type {Function|null} */
  outsideClickHandler = null;

  /**
   * @param {import('../state.js').ApplicationState} state
   */
  async install(state) {
    await super.install(state);

    const container = document.createElement('div');
    document.body.appendChild(container);
    createFromTemplate('help-widget', container);
    this.#ui = this.createUi(container);

    this.#ui.helpIcon.style.display = 'none';

    this.#ui.helpIcon.addEventListener('click', () => {
      if (this.menuVisible) {
        this.hideTopicsMenu();
      } else {
        this.renderTopicsMenu();
      }
    });

    this.outsideClickHandler = (e) => {
      if (this.menuVisible &&
          !this.#ui.helpIcon.contains(e.target) &&
          !this.#ui.topicsContainer.contains(e.target)) {
        this.hideTopicsMenu();
      }
    };
    document.addEventListener('click', this.outsideClickHandler);
  }

  /**
   * Register a help topic that will appear in the radial menu
   * @param {string} label - Topic display name
   * @param {string} icon - Shoelace icon name
   * @param {Function} callback - Handler when topic is selected
   * @returns {string} Topic ID for later removal
   */
  registerTopic(label, icon, callback) {
    const topicId = `topic-${Date.now()}-${Math.random()}`;
    this.topics.push({ id: topicId, label, icon, callback });
    this.updateIconVisibility();
    return topicId;
  }

  /**
   * Unregister a previously registered help topic
   * @param {string} topicId - ID returned from registerTopic
   */
  unregisterTopic(topicId) {
    this.topics = this.topics.filter(t => t.id !== topicId);
    this.updateIconVisibility();
    if (this.topics.length === 0 && this.menuVisible) {
      this.hideTopicsMenu();
    }
  }

  updateIconVisibility() {
    this.#ui.helpIcon.style.display = this.topics.length > 0 ? 'block' : 'none';
  }

  renderTopicsMenu() {
    const container = this.#ui.topicsContainer;
    container.innerHTML = '';

    this.topics.forEach((topic) => {
      const box = document.createElement('div');
      box.className = 'help-topic';
      box.innerHTML = `
        <sl-icon name="${topic.icon}"></sl-icon>
        <span>${topic.label}</span>
      `;
      box.addEventListener('click', () => {
        this.hideTopicsMenu();
        topic.callback();
      });
      container.appendChild(box);
      requestAnimationFrame(() => { box.classList.add('visible'); });
    });

    container.classList.add('visible');
    this.menuVisible = true;
  }

  hideTopicsMenu() {
    const container = this.#ui.topicsContainer;
    container.querySelectorAll('.help-topic').forEach(el => el.classList.remove('visible'));
    setTimeout(() => {
      container.innerHTML = '';
      container.classList.remove('visible');
      this.menuVisible = false;
    }, 300);
  }
}

export default HelpPlugin;

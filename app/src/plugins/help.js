import { Plugin } from '../modules/plugin-base.js';
import { registerTemplate, createFromTemplate, updateUi } from '../ui.js';

/**
 * @typedef HelpTopic
 * @property {string} id - Unique topic identifier
 * @property {string} label - Topic display name
 * @property {string} icon - Shoelace icon name
 * @property {Function} callback - Handler when topic is selected
 */

/**
 * @typedef HelpWidgetElements
 * @property {HTMLDivElement} helpIcon - Help icon wrapper (contains sl-icon with tooltip)
 * @property {HTMLDivElement} topicsContainer - Container for topic boxes
 */

/**
 * Help plugin that displays contextual help topics in a radial menu.
 * Other plugins can register help topics that appear when users click the help icon.
 */
class HelpPlugin extends Plugin {
  /**
   * @type {Array<HelpTopic>}
   * @private
   */
  topics = [];

  /**
   * @type {boolean}
   * @private
   */
  menuVisible = false;

  /**
   * @type {Function|null}
   * @private
   */
  outsideClickHandler = null;

  constructor(context) {
    super(context, {
      name: 'help',
      deps: []
    });
  }

  /**
   * Install the help widget
   * @param {import('../state.js').State} state
   */
  async install(state) {
    await super.install(state);

    await registerTemplate('help-widget', 'help-widget.html');
    const editorsContainer = document.getElementById('editors');
    createFromTemplate('help-widget', editorsContainer);
    updateUi();

    // Initially hidden (no topics yet)
    ui.helpIcon.style.display = 'none';

    // Icon click handler - toggle menu
    ui.helpIcon.addEventListener('click', () => {
      if (this.menuVisible) {
        this.hideTopicsMenu();
      } else {
        this.renderTopicsMenu();
      }
    });

    // Close menu when clicking outside
    this.outsideClickHandler = (e) => {
      if (this.menuVisible &&
          !ui.helpIcon.contains(e.target) &&
          !ui.topicsContainer.contains(e.target)) {
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

  /**
   * Update help icon visibility based on registered topics
   * @private
   */
  updateIconVisibility() {
    ui.helpIcon.style.display =
      this.topics.length > 0 ? 'block' : 'none';
  }

  /**
   * Render the topics menu in a quarter circle layout
   * @private
   */
  renderTopicsMenu() {
    const container = ui.topicsContainer;
    container.innerHTML = '';

    // Stack topics vertically above the help icon
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

      // Trigger animation after DOM insertion
      requestAnimationFrame(() => {
        box.classList.add('visible');
      });
    });

    container.classList.add('visible');
    this.menuVisible = true;
  }

  /**
   * Hide the topics menu with animation
   * @private
   */
  hideTopicsMenu() {
    const container = ui.topicsContainer;
    const topics = container.querySelectorAll('.help-topic');

    topics.forEach(el => el.classList.remove('visible'));

    // Wait for animation to complete before clearing DOM
    setTimeout(() => {
      container.innerHTML = '';
      container.classList.remove('visible');
      this.menuVisible = false;
    }, 300);
  }
}

export default HelpPlugin;

/**
 * Spacer widget for toolbar/statusbar
 * Fills available space to push subsequent widgets to the right
 */

class StatusSpacer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex: 1;
          min-width: 0;
        }
      </style>
    `;
  }
}

customElements.define('status-spacer', StatusSpacer);

export { StatusSpacer };

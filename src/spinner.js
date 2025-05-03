/**
 * A spinner/blocker for long-running tasks
 * Adapted from https://codeburst.io/how-to-create-a-simple-css-loading-spinner-make-it-accessible-e5c83c2e464c
 */

const spinnerCss = `
  @keyframes spinner {
    0% {
      transform: translate3d(-50%, -50%, 0) rotate(0deg);
    }
    100% {
      transform: translate3d(-50%, -50%, 0) rotate(360deg);
    }
  }

  .spinner-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    flex-direction: column; /* Arrange spinner and message vertically */
    justify-content: center;
    align-items: center;
    color: white; /* Make the message text visible against the blocker */
    font-size: 1.2em; /* Adjust font size as needed */
  }

  .spinner {
    opacity: 1;
    position: relative;
    transition: opacity linear 0.1s;
    margin-bottom: 1em; /* Add spacing between spinner and message */
    &::before {
      animation: 2s linear infinite spinner;
      border: solid 3px #eee;
      border-bottom-color: #EF6565;
      border-radius: 50%;
      content: "";
      height: 40px;
      left: 50%;
      opacity: inherit;
      position: absolute;
      top: 50%;
      transform: translate3d(-50%, -50%, 0);
      transform-origin: center;
      width: 40px;
      will-change: transform;
    }
  }

  .hidden {
    display: none;
  }

  .message { /* Style for the message text */
    text-align: center;
    padding: 0.5em;
  }
`;

export class Spinner extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });

    // Create CSS style element
    const style = document.createElement('style');
    style.textContent = spinnerCss;
    this.shadow.appendChild(style);

    this.container = document.createElement('div');
    this.container.classList.add('spinner-container', 'hidden');

    this.spinner = document.createElement('div');
    this.spinner.classList.add('spinner');

    this.messageElement = document.createElement('div'); // Create the message element
    this.messageElement.classList.add('message');

    this.container.appendChild(this.spinner);
    this.container.appendChild(this.messageElement); // Append the message element

    this.shadow.appendChild(this.container);
  }

  connectedCallback() { }
  disconnectedCallback() { }
  attributeChangedCallback(name, oldValue, newValue) { }

  show(message='') {
    this.messageElement.textContent = message; // Set the message text
    this.container.classList.remove('hidden');
  }

  hide() {
    this.container.classList.add('hidden');
  }

  static get observedAttributes() {
    return [];
  }
}

customElements.define('custom-spinner', Spinner);
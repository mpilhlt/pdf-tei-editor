
/**
 * A on/off switch
 * Adapted from https://uiverse.io/Bodyhc/red-lionfish-43
 * Written by Abdullah M Soliman
 */

const css = `
    /* From Uiverse.io by Bodyhc */ 
  .checkbox-wrapper-35 .switch {
    display: none;
  }

  .checkbox-wrapper-35 .switch + label {
    -webkit-box-align: center;
    -webkit-align-items: center;
    -ms-flex-align: center;
    align-items: center;
    color: #78768d;
    cursor: pointer;
    display: -webkit-box;
    display: -webkit-flex;
    display: -ms-flexbox;
    display: flex;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 12px;
    line-height: 15px;
    position: relative;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
  }

  .checkbox-wrapper-35 .switch + label::before,
    .checkbox-wrapper-35 .switch + label::after {
    content: '';
    display: block;
  }

  .checkbox-wrapper-35 .switch + label::before {
    background-color: #05012c;
    border-radius: 500px;
    height: 15px;
    margin-right: 8px;
    -webkit-transition: background-color 0.125s ease-out;
    transition: background-color 0.125s ease-out;
    width: 25px;
  }

  .checkbox-wrapper-35 .switch + label::after {
    background-color: #fff;
    border-radius: 13px;
    box-shadow: 0 3px 1px 0 rgba(37, 34, 71, 0.05), 0 2px 2px 0 rgba(37, 34, 71, 0.1), 0 3px 3px 0 rgba(37, 34, 71, 0.05);
    height: 13px;
    left: 1px;
    position: absolute;
    top: 1px;
    -webkit-transition: -webkit-transform 0.125s ease-out;
    transition: -webkit-transform 0.125s ease-out;
    transition: transform 0.125s ease-out;
    transition: transform 0.125s ease-out, -webkit-transform 0.125s ease-out;
    width: 13px;
  }

  .checkbox-wrapper-35 .switch + label .switch-x-text {
    display: block;
    margin-right: .3em;
  }

  .checkbox-wrapper-35 .switch + label .switch-x-toggletext {
    display: block;
    font-weight: bold;
    height: 15px;
    overflow: hidden;
    position: relative;
    width: 25px;
  }

  .checkbox-wrapper-35 .switch + label .switch-x-unchecked,
    .checkbox-wrapper-35 .switch + label .switch-x-checked {
    left: 0;
    position: absolute;
    top: 0;
    -webkit-transition: opacity 0.125s ease-out, -webkit-transform 0.125s ease-out;
    transition: opacity 0.125s ease-out, -webkit-transform 0.125s ease-out;
    transition: transform 0.125s ease-out, opacity 0.125s ease-out;
    transition: transform 0.125s ease-out, opacity 0.125s ease-out, -webkit-transform 0.125s ease-out;
  }

  .checkbox-wrapper-35 .switch + label .switch-x-unchecked {
    opacity: 1;
    -webkit-transform: none;
    transform: none;
  }

  .checkbox-wrapper-35 .switch + label .switch-x-checked {
    opacity: 0;
    -webkit-transform: translate3d(0, 100%, 0);
    transform: translate3d(0, 100%, 0);
  }

  .checkbox-wrapper-35 .switch + label .switch-x-hiddenlabel {
    position: absolute;
    visibility: hidden;
  }

  .checkbox-wrapper-35 .switch:checked + label::before {
    background-color: #ffb500;
  }

  .checkbox-wrapper-35 .switch:checked + label::after {
    -webkit-transform: translate3d(10px, 0, 0);
    transform: translate3d(10px, 0, 0);
  }

  .checkbox-wrapper-35 .switch:checked + label .switch-x-unchecked {
    opacity: 0;
    -webkit-transform: translate3d(0, -100%, 0);
    transform: translate3d(0, -100%, 0);
  }

  .checkbox-wrapper-35 .switch:checked + label .switch-x-checked {
    opacity: 1;
    -webkit-transform: none;
    transform: none;
  }

`;

const html = `
<div class="checkbox-wrapper-35">
  <input value="private" name="switch" id="switch" type="checkbox" class="switch">
  <label for="switch">
    <span class="switch-x-text"></span>
    <span class="switch-x-toggletext">
      <span class="switch-x-unchecked"></span>
      <span class="switch-x-checked"></span>
    </span>
  </label>
</div>
`

export class Switch extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });

    // Create CSS style element
    const style = document.createElement('style');
    style.textContent = css;
    this.shadow.appendChild(style);

    const elem = document.createElement('div');
    elem.innerHTML=html
    this.elem = elem
    this.shadow.appendChild(elem);    

    this.checkbox = this.shadow.querySelector('input[type="checkbox"]'); // Get the checkbox element.
    // Observe changes to the "checked" attribute
    this.observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            if (mutation.attributeName === 'checked') {
              this.checked = this.checkbox.checked;
            }
        });
    });
    this.observer.observe(this.checkbox, { attributes: true });  // Observe the checkbox 
    this.checkbox.addEventListener('change', () => { 
      this.checked = this.checkbox.checked;
    });    
  }

  #oldChecked = false;

  get checked() {
    const value = this.checkbox?.checked || false
    return value
  }

  set checked(value) {
    if (value !== this.#oldChecked) {
      this.checkbox.checked = value
      this.elem.setAttribute('checked', value)
      this.dispatchEvent(new CustomEvent('change', {
        detail: { checked: value }
      }));
      this.#oldChecked = value
    }
  }

  connectedCallback() { }

  disconnectedCallback() {
    this.observer.disconnect();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "checked") {
      this.checked === Boolean(newValue)
    } else {
      this.updateLabels();
    }
  }

  updateLabels() {
    if (!this.elem) {
      return;
    }

    const text = this.shadow.querySelector(".switch-x-text");
    const checked = this.shadow.querySelector(".switch-x-checked");
    const unchecked = this.shadow.querySelector(".switch-x-unchecked");

    if (text) {
      text.textContent = this.getAttribute("label") || "";
    }
    if (checked) {
      checked.textContent = this.getAttribute("label-on") || "";
    }
    if (unchecked) {
      unchecked.textContent = this.getAttribute("label-off") || "";
    }
  }

  show() {
    this.container.classList.remove('hidden');
  }

  hide() {
    this.container.classList.add('hidden');
  }

  static get observedAttributes() {
    return ['label', 'label-on', 'label-off', 'value', 'checked'];
  }
}

customElements.define('custom-switch', Switch);
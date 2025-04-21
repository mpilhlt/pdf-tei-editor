/**
 * Adapted from code written by Gemini 2.0 Flash
 */
class JsonListEditor extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this._data = []; // Internal data store
    this._draggedItemIndex = null;  // Track the index of the dragged item

    this.shadow.innerHTML = `
        <style>

          .container {
            border: 1px solid #ccc;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
          }

          .list-container {
            display: block
            overflow-y: auto;
            flex-grow: 1;
            padding: 5px; /* Add some padding for better visual separation */
            width: 100%;
            height: 100%;
            box-sizing: border-box; /* Include padding in height calculation */
          }

          .list-item {
            display: flex;
            align-items: center;
            padding: 5px;
            border: 1px solid #eee;
            margin-bottom: 5px;
            background-color: #f9f9f9;
            position: relative;
            gap:10px;
            transition: background-color 0.3s ease;
            cursor: grab; /* Indicate draggable */
          }

          .list-item:hover {
            background-color: #f0f0f0;
          }

          .list-item:hover .actions {
            visibility: visible;
          }

          .list-item.dragging {
            opacity: 0.5; /* Indicate item is being dragged */
          }

          .list-item input[type="checkbox"] {
            margin-right: 10px;
          }

          .list-item label {
            flex-grow: 1;
            margin-right: 10px;
            cursor: pointer;
          }

          .list-item input[type="text"],
          .list-item textarea {
            flex-grow: 2;
            margin-right: 10px;
            padding: 5px;
            border: 1px solid #ccc;
            border-radius: 4px;
            cursor: pointer;
          }

          .list-item input[type="text"]:disabled,
          .list-item textarea:disabled  {
            background-color: #eee;
            cursor: not-allowed;
          }

          .list-item label:hover,
          .list-item textarea:hover,
          .list-item input[type="text"]:hover {
              background-color: #ddd;
          }

          .actions {
            visibility: hidden;
            position: absolute;
            right: 5px;
            top: 5px;
          }

          .actions button {
            background-color: transparent;
            border: none;
            cursor: pointer;
            font-size: 1.2em;
            margin-left: 5px;
            color: #555;
          }

          .footer {
            display: flex;
            justify-content: space-between;
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #ccc;
            width: 100%;
          }

          .footer button {
            padding: 8px 12px;
            background-color: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
          }

          .footer button:hover {
            background-color: #3e8e41;
          }

        </style>
        <div class="container">
          <div class="list-container">
            <ul id="list"></ul>
          </div>
          <div class="footer">
            <button id="add">Add</button>
            <button id="close">Close</button>
          </div>
        </div>
      `;

    this.listElement = this.shadow.getElementById('list');
    this.addButton = this.shadow.getElementById('add');
    this.closeButton = this.shadow.getElementById('close');

    this.addButton.addEventListener('click', this.addItem.bind(this));
    this.closeButton.addEventListener('click', this.close.bind(this));

    this.listElement.addEventListener('focusout', this.handleItemBlur.bind(this), true);

    // Add drag and drop event listeners to the list container
    this.listElement.addEventListener('dragstart', this.handleDragStart.bind(this));
    this.listElement.addEventListener('dragover', this.handleDragOver.bind(this));
    this.listElement.addEventListener('drop', this.handleDrop.bind(this));
    this.listElement.addEventListener('dragend', this.handleDragEnd.bind(this)); // Handle cleanup
  }

  connectedCallback() {
    this.render();
  }

  static get observedAttributes() {
    return [];
  }

  attributeChangedCallback(name, oldValue, newValue) {}

  get data() {
    return this._data;
  }

  set data(value) {
    if (!Array.isArray(value)) {
      throw new TypeError('Data must be an array');
    }
    // make sure data has the right format
    this._data = value.map(item => {
      try {
        let {label, active, text} = item;
        return { label: label || '', active: active !== undefined ? active : true, text: text || '' };
      } catch (error) {
        console.error('Error setting data:', error);
      }
    });
    this.render(); // Re-render when data changes
  }

  render() {
    this.listElement.innerHTML = ''; // Clear the list
    this._data.forEach((item, index) => {
      const listItem = this.createListItem(item, index);
      this.listElement.appendChild(listItem);
    });
  }


  createListItem(item, index) {
    const listItem = document.createElement('li');
    listItem.classList.add('list-item');
    listItem.draggable = true;  // Make the list item draggable
    listItem.dataset.index = index; // Store index for drag operations


    // active
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.active;
    checkbox.dataset.key = 'active';
    checkbox.dataset.index = index;
    checkbox.addEventListener('change', () => this.toggleActive(index, checkbox.checked));

    // label
    const label = document.createElement('input');
    label.value = item.label;
    label.placeholder = "A short label for this prompt fragment";
    label.setAttribute('tabindex', '0');  // Make label focusable
    label.disabled = !item.active;
    label.dataset.key = 'label';
    label.dataset.index = index;

    // text
    const textbox = document.createElement('textarea');
    textbox.value = item.text;
    textbox.placeholder = "The prompt fragment";
    textbox.rows = 3; // Set the number of rows for the textarea
    textbox.setAttribute('tabindex', '0');  // Make textbox focusable
    textbox.disabled = !item.active;
    textbox.dataset.key = 'text';
    textbox.dataset.index = index;

    // action buttons
    const actions = document.createElement('div');
    actions.classList.add('actions');

    const copyButton = document.createElement('button');
    copyButton.innerHTML = '📋'; // Copy icon
    copyButton.addEventListener('click', () => this.copyItem(index));

    const deleteButton = document.createElement('button');
    deleteButton.innerHTML = '❌'; // Delete icon
    deleteButton.addEventListener('click', () => this.deleteItem(index));

    actions.appendChild(copyButton);
    actions.appendChild(deleteButton);


    listItem.appendChild(checkbox);
    listItem.appendChild(label);
    listItem.appendChild(textbox);
    listItem.appendChild(actions);

    return listItem;
  }


  handleDragStart(event) {
    this._draggedItemIndex = parseInt(event.target.dataset.index, 10);

    if (isNaN(this._draggedItemIndex)) {
      event.preventDefault(); // Prevent dragging if not a valid item
      return;
    }

    event.dataTransfer.setData('text/plain', this._draggedItemIndex); // Store the index
    event.dataTransfer.effectAllowed = 'move';
    event.target.classList.add('dragging'); // Add dragging class
  }


  handleDragOver(event) {
    event.preventDefault(); // Required to allow dropping
    event.dataTransfer.dropEffect = 'move';  // Indicate the type of move that will happen

  }


  handleDrop(event) {
    event.preventDefault();
    const droppedIndex = parseInt(event.target.dataset.index, 10);

    if (isNaN(droppedIndex) || this._draggedItemIndex === null) {
      return; // Prevent dropping if not a valid item or drag didn't start correctly.
    }

    // Reorder the data
    const item = this._data[this._draggedItemIndex];
    this._data.splice(this._draggedItemIndex, 1); // Remove from old position
    this._data.splice(droppedIndex, 0, item);    // Insert into new position

    this._draggedItemIndex = null;  // Reset the dragged item index

    this.render(); // Re-render the list
    this.dispatchEvent(new CustomEvent('data-changed', { detail: this._data }));
  }


  handleDragEnd(event) {
    event.target.classList.remove('dragging'); // Cleanup: Remove dragging class
    this._draggedItemIndex = null;
  }


  toggleActive(index, active) {
    this._data[index].active = active;
    this.render(); //Re-render to update the disabled state of the input
    this.dispatchEvent(new CustomEvent('data-changed', { detail: this._data }));
  }


  handleItemBlur(event) {
    const target = event.target;
    const index = parseInt(target.dataset.index, 10);
    const key = target.dataset.key;
    this._data[index][key] = target.value;
    this.dispatchEvent(new CustomEvent('data-changed', { detail: this._data }));
  }


  copyItem(index) {
    const newItem = { ...this._data[index] }; // Create a shallow copy
    this._data.splice(index + 1, 0, newItem);
    this.render();
    this.dispatchEvent(new CustomEvent('data-changed', { detail: this._data }));
  }

  deleteItem(index) {
    this._data.splice(index, 1);
    this.render();
    this.dispatchEvent(new CustomEvent('data-changed', { detail: this._data }));
  }

  addItem() {
    const newItem = { label: '', active: true, text: '' };
    this._data.push(newItem);
    this.render();
    this.dispatchEvent(new CustomEvent('data-changed', { detail: this._data }));
  }

  close() {
    this.dispatchEvent(new CustomEvent('close'));
  }
}

customElements.define('json-list-editor', JsonListEditor);
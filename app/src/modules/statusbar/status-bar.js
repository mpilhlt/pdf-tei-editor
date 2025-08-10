/**
 * Modern status bar container component inspired by VS Code
 * Manages layout and responsive behavior for status bar widgets
 */

class StatusBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.widgets = new Map();
    this.positions = {
      left: [],
      center: [],
      right: []
    };
    
    this.render();
    this.setupEventListeners();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 22px;
          padding: 0 8px;
          background-color: var(--sl-color-neutral-50);
          border-top: 1px solid var(--sl-color-neutral-200);
          font-size: var(--sl-font-size-x-small);
          color: var(--sl-color-neutral-600);
          gap: 8px;
          overflow: hidden;
        }

        .section {
          display: flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
        }

        .section.left {
          justify-content: flex-start;
          flex: 1;
        }

        .section.center {
          justify-content: center;
          flex: 0 1 auto;
        }

        .section.right {
          justify-content: flex-end;
          flex: 1;
        }

        ::slotted(*) {
          white-space: nowrap;
        }

        @media (max-width: 768px) {
          .section.center {
            display: none;
          }
          
          ::slotted([data-priority="1"]),
          ::slotted([data-priority="2"]),
          ::slotted([data-priority="3"]) {
            display: none !important;
          }
        }

        @media (max-width: 600px) {
          ::slotted([data-priority="4"]),
          ::slotted([data-priority="5"]) {
            display: none !important;
          }
        }

        @media (max-width: 480px) {
          :host {
            padding: 0 4px;
            gap: 4px;
          }
          .section {
            gap: 2px;
          }
          
          ::slotted([data-priority="6"]),
          ::slotted([data-priority="7"]) {
            display: none !important;
          }
        }

        @media (max-width: 360px) {
          ::slotted([data-priority="8"]) {
            display: none !important;
          }
        }
      </style>
      
      <div class="section left">
        <slot name="left"></slot>
      </div>
      <div class="section center">
        <slot name="center"></slot>
      </div>
      <div class="section right">
        <slot name="right"></slot>
      </div>
    `;
  }

  setupEventListeners() {
    this.addEventListener('widget-click', this.handleWidgetClick.bind(this));
    this.addEventListener('widget-change', this.handleWidgetChange.bind(this));
  }

  handleWidgetClick(event) {
    // Bubble up widget click events for external handling
    this.dispatchEvent(new CustomEvent('status-action', {
      bubbles: true,
      detail: {
        action: event.detail.action,
        widget: event.detail.widget
      }
    }));
  }

  handleWidgetChange(event) {
    // Bubble up widget change events for external handling
    this.dispatchEvent(new CustomEvent('status-change', {
      bubbles: true,
      detail: {
        value: event.detail.value,
        widget: event.detail.widget
      }
    }));
  }

  /**
   * Add a widget to the status bar
   * @param {HTMLElement} widget - The widget element
   * @param {string} position - 'left', 'center', or 'right'
   * @param {number} priority - Higher priority widgets stay visible longer (default: 0)
   */
  addWidget(widget, position = 'left', priority = 0) {
    if (!['left', 'center', 'right'].includes(position)) {
      throw new Error('Position must be "left", "center", or "right"');
    }

    const widgetId = widget.id || `widget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    widget.id = widgetId;
    widget.slot = position;
    widget.dataset.priority = priority;

    this.widgets.set(widgetId, { element: widget, position, priority });
    this.positions[position].push({ id: widgetId, priority });
    
    // Sort by priority (higher first)
    this.positions[position].sort((a, b) => b.priority - a.priority);
    
    this.appendChild(widget);
    return widgetId;
  }

  /**
   * Remove a widget from the status bar
   * @param {string} widgetId - The ID of the widget to remove
   */
  removeWidget(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    const { position } = widget;
    this.positions[position] = this.positions[position].filter(w => w.id !== widgetId);
    
    if (widget.element.parentNode === this) {
      this.removeChild(widget.element);
    }
    
    this.widgets.delete(widgetId);
    return true;
  }

  /**
   * Clear all widgets from the status bar
   */
  clearWidgets() {
    this.widgets.forEach((widget) => {
      if (widget.element.parentNode === this) {
        this.removeChild(widget.element);
      }
    });
    
    this.widgets.clear();
    this.positions = { left: [], center: [], right: [] };
  }

  /**
   * Get all widgets in a specific position
   * @param {string} position - 'left', 'center', or 'right'
   */
  getWidgets(position) {
    if (position) {
      return this.positions[position].map(w => this.widgets.get(w.id));
    }
    return Array.from(this.widgets.values());
  }

  /**
   * Update widget priority
   * @param {string} widgetId - The widget ID
   * @param {number} priority - New priority value
   */
  updatePriority(widgetId, priority) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    widget.priority = priority;
    widget.element.dataset.priority = priority;

    const { position } = widget;
    const positionWidget = this.positions[position].find(w => w.id === widgetId);
    if (positionWidget) {
      positionWidget.priority = priority;
      this.positions[position].sort((a, b) => b.priority - a.priority);
    }

    return true;
  }
}

customElements.define('status-bar', StatusBar);

export { StatusBar };
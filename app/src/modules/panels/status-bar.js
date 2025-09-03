/**
 * Modern status bar container component inspired by VS Code
 * Manages layout and responsive behavior for status bar widgets
 * Provides consistent event handling with other panel components
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
    this.hiddenWidgets = new Set();
    this.resizeObserver = null;
    this.measurementCache = new Map();
    
    this.render();
    this.setupEventListeners();
    this.setupOverflowDetection();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          align-items: center;
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
          flex: 0 1 auto;
        }

        .section.center {
          justify-content: center;
          flex: 1;
        }

        .section.right {
          justify-content: flex-end;
          flex: 0 1 auto;
          margin-left: auto;
        }

        ::slotted(*) {
          white-space: nowrap;
        }

        /* Special styling for title widgets to allow expansion */
        ::slotted(.title-widget) {
          flex-grow: 1;
          min-width: 0;
        }

        /* Dynamic overflow hiding - applied via JavaScript */
        ::slotted([data-overflow-hidden]) {
          display: none !important;
        }

        /* Smooth transitions for hiding/showing */
        ::slotted(*) {
          transition: opacity 0.1s ease;
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

  setupOverflowDetection() {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          this.checkAndResolveOverflow();
        }
      });
    }

    // Also check overflow when widgets are added or modified
    this.addEventListener('slotchange', () => {
      setTimeout(() => this.checkAndResolveOverflow(), 0);
    });
  }

  connectedCallback() {
    if (this.resizeObserver) {
      this.resizeObserver.observe(this);
    }
    // Initial overflow check after everything is rendered
    setTimeout(() => this.checkAndResolveOverflow(), 100);
  }

  disconnectedCallback() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  checkAndResolveOverflow() {
    const containerRect = this.getBoundingClientRect();
    const availableWidth = containerRect.width;
    
    if (availableWidth === 0) return; // Not rendered yet

    // Get all widgets with their measurements
    const allWidgets = this.getAllWidgetsWithPriority();
    const totalWidth = this.calculateTotalWidth(allWidgets);
    
    // Add a small safety margin to prevent edge cases
    const safetyMargin = 5;
    const effectiveAvailableWidth = availableWidth - safetyMargin;
    
    if (totalWidth > effectiveAvailableWidth) {
      this.hideWidgetsToFit(allWidgets, effectiveAvailableWidth);
    } else {
      this.showWidgetsIfSpace(allWidgets, effectiveAvailableWidth);
    }
  }

  getAllWidgetsWithPriority() {
    const widgets = [];
    
    // Get all slotted elements
    const leftSlot = this.shadowRoot.querySelector('slot[name="left"]');
    const centerSlot = this.shadowRoot.querySelector('slot[name="center"]');
    const rightSlot = this.shadowRoot.querySelector('slot[name="right"]');
    
    [leftSlot, centerSlot, rightSlot].forEach(slot => {
      if (slot) {
        const slottedElements = slot.assignedElements();
        slottedElements.forEach(widget => {
          const priority = parseInt(widget.dataset.priority) || 0;
          widgets.push({ element: widget, priority, slot: slot.name });
        });
      }
    });
    
    return widgets;
  }

  calculateTotalWidth(widgets) {
    let totalWidth = 0;
    const containerStyle = getComputedStyle(this);
    const paddingLeft = parseInt(containerStyle.paddingLeft) || 8;
    const paddingRight = parseInt(containerStyle.paddingRight) || 8;
    
    totalWidth += paddingLeft + paddingRight;
    
    // Group widgets by section
    const sections = { left: [], center: [], right: [] };
    widgets.forEach(widget => {
      if (!widget.element.hasAttribute('data-overflow-hidden')) {
        sections[widget.slot].push(widget);
      }
    });
    
    // Calculate minimum width needed for each section's content
    let leftWidth = 0, centerWidth = 0, rightWidth = 0;
    
    sections.left.forEach((widget, index) => {
      const rect = widget.element.getBoundingClientRect();
      leftWidth += rect.width;
      if (index < sections.left.length - 1) leftWidth += 4; // Gap between widgets
    });
    
    sections.center.forEach((widget, index) => {
      const rect = widget.element.getBoundingClientRect();
      centerWidth += rect.width;
      if (index < sections.center.length - 1) centerWidth += 4; // Gap between widgets
    });
    
    sections.right.forEach((widget, index) => {
      const rect = widget.element.getBoundingClientRect();
      rightWidth += rect.width;
      if (index < sections.right.length - 1) rightWidth += 4; // Gap between widgets
    });
    
    // Add the content widths
    totalWidth += leftWidth + centerWidth + rightWidth;
    
    // Add gaps between sections (8px each)
    const activeSections = [leftWidth, centerWidth, rightWidth].filter(w => w > 0);
    if (activeSections.length > 1) {
      totalWidth += (activeSections.length - 1) * 8; // 8px gap between sections
    }
    
    return totalWidth;
  }

  hideWidgetsToFit(allWidgets, availableWidth) {
    // Sort by priority (lowest first) for hiding
    const sortedWidgets = allWidgets
      .filter(w => !w.element.hasAttribute('data-overflow-hidden'))
      .sort((a, b) => a.priority - b.priority);
    
    let currentWidth = this.calculateTotalWidth(allWidgets);
    
    for (const widget of sortedWidgets) {
      if (currentWidth <= availableWidth) break;
      
      // Hide this widget
      widget.element.setAttribute('data-overflow-hidden', '');
      this.hiddenWidgets.add(widget.element);
      
      // Recalculate width
      currentWidth = this.calculateTotalWidth(allWidgets);
    }
  }

  showWidgetsIfSpace(allWidgets, availableWidth) {
    // Sort hidden widgets by priority (highest first) for showing
    const hiddenWidgets = Array.from(this.hiddenWidgets)
      .map(element => {
        const priority = parseInt(element.dataset.priority) || 0;
        return { element, priority };
      })
      .sort((a, b) => b.priority - a.priority);
    
    for (const widget of hiddenWidgets) {
      // Temporarily show the widget to measure
      widget.element.removeAttribute('data-overflow-hidden');
      const testWidth = this.calculateTotalWidth(allWidgets);
      
      if (testWidth <= availableWidth) {
        // Keep it shown
        this.hiddenWidgets.delete(widget.element);
      } else {
        // Hide it again
        widget.element.setAttribute('data-overflow-hidden', '');
        break;
      }
    }
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
    
    // Also emit generic panel-action for consistency with other components
    this.dispatchEvent(new CustomEvent('panel-action', {
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
    
    // Also emit generic panel-change for consistency with other components
    this.dispatchEvent(new CustomEvent('panel-change', {
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
  add(widget, position = 'left', priority = 0) {
    if (!['left', 'center', 'right'].includes(position)) {
      throw new Error('Position must be "left", "center", or "right"');
    }

    const widgetId = widget.id || `widget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    widget.id = widgetId;
    widget.slot = position;
    widget.dataset.priority = String(priority);

    this.widgets.set(widgetId, { element: widget, position, priority });
    this.positions[position].push({ id: widgetId, priority });
    
    // Sort by priority (higher first)
    this.positions[position].sort((a, b) => b.priority - a.priority);
    
    this.appendChild(widget);
    
    // Check for overflow after adding
    setTimeout(() => this.checkAndResolveOverflow(), 0);
    
    return widgetId;
  }

  /**
   * Remove a widget from the status bar
   * @param {string} widgetId - The ID of the widget to remove
   */
  removeById(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    const { position, element } = widget;
    this.positions[position] = this.positions[position].filter(w => w.id !== widgetId);
    
    // Remove from hidden widgets set
    this.hiddenWidgets.delete(element);
    
    if (element.parentNode === this) {
      this.removeChild(element);
    }
    
    this.widgets.delete(widgetId);
    
    // Check if we can show more widgets after removal
    setTimeout(() => this.checkAndResolveOverflow(), 0);
    
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
    this.hiddenWidgets.clear();
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
/**
 * Base horizontal panel component with priority-based overflow management
 * Provides common functionality for StatusBar, MenuBar, and ToolBar
 */

class BasePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.widgets = new Map();
    this.hiddenWidgets = new Set();
    this.resizeObserver = null;
    this.overflowContainer = null;
    
    this.setupEventListeners();
    this.setupOverflowDetection();
  }

  /**
   * Override in subclasses to provide custom rendering
   */
  render() {
    throw new Error('render() must be implemented by subclass');
  }

  /**
   * Override in subclasses to create overflow containers
   * @returns {HTMLElement|null} The overflow container element
   */
  createOverflowContainer() {
    return null;
  }

  /**
   * Override in subclasses to handle overflow widget display
   * @param {Array} hiddenWidgets - Array of hidden widget objects
   */
  updateOverflowContainer(hiddenWidgets) {
    // Default implementation does nothing
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
      setTimeout(() => this.checkAndResolveOverflow(), 100);
    });
  }

  connectedCallback() {
    this.render();
    
    if (this.resizeObserver) {
      this.resizeObserver.observe(this);
    }
    // Initial overflow check after everything is rendered (longer delay for plugins to add widgets)
    setTimeout(() => this.checkAndResolveOverflow(), 500);
  }

  disconnectedCallback() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  checkAndResolveOverflow() {
    // Check if smart overflow management is disabled
    if (this.getAttribute('smart-overflow') !== 'on') {
      return;
    }
    
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

    // Update overflow container after hiding/showing widgets
    const hiddenWidgetObjects = Array.from(this.hiddenWidgets).map(element => {
      const priority = parseInt(element.dataset.priority) || 0;
      return { element, priority };
    });
    this.updateOverflowContainer(hiddenWidgetObjects);
  }

  getAllWidgetsWithPriority() {
    const widgets = [];
    
    // Get all slotted elements from the main slot
    // @ts-ignore
    const mainSlot = this.shadowRoot.querySelector('slot:not([name])');
    if (mainSlot) {
      // @ts-ignore
      const slottedElements = mainSlot.assignedElements();
      slottedElements.forEach(widget => {
        // Skip the overflow container itself
        if (widget === this.overflowContainer) return;
        
        const priority = parseInt(widget.dataset.priority) || 0;
        widgets.push({ element: widget, priority });
      });
    }
    
    return widgets;
  }

  calculateTotalWidth(widgets) {
    let totalWidth = 0;
    const containerStyle = getComputedStyle(this);
    const paddingLeft = parseInt(containerStyle.paddingLeft) || 0;
    const paddingRight = parseInt(containerStyle.paddingRight) || 0;
    
    totalWidth += paddingLeft + paddingRight;
    
    // Calculate width of visible widgets
    widgets.forEach((widget, index) => {
      if (!widget.element.hasAttribute('data-overflow-hidden')) {
        const rect = widget.element.getBoundingClientRect();
        totalWidth += rect.width;
        
        // Add gap between widgets
        if (index < widgets.length - 1) {
          const gap = parseInt(containerStyle.gap) || 4;
          totalWidth += gap;
        }
      }
    });

    // Include overflow container if it exists and is visible
    if (this.overflowContainer && !this.overflowContainer.hasAttribute('data-overflow-hidden')) {
      const overflowRect = this.overflowContainer.getBoundingClientRect();
      totalWidth += overflowRect.width;
      if (widgets.some(w => !w.element.hasAttribute('data-overflow-hidden'))) {
        const gap = parseInt(containerStyle.gap) || 4;
        totalWidth += gap;
      }
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
      
      // Show overflow container if we have hidden widgets
      if (this.overflowContainer) {
        this.overflowContainer.removeAttribute('data-overflow-hidden');
      }
      
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

    // Hide overflow container if no widgets are hidden
    if (this.hiddenWidgets.size === 0 && this.overflowContainer) {
      this.overflowContainer.setAttribute('data-overflow-hidden', '');
    }
  }

  handleWidgetClick(event) {
    // Bubble up widget click events for external handling
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
    this.dispatchEvent(new CustomEvent('panel-change', {
      bubbles: true,
      detail: {
        value: event.detail.value,
        widget: event.detail.widget
      }
    }));
  }

  /**
   * Internal method to add a widget to the panel
   * @param {HTMLElement} widget - The widget element
   * @param {number} priority - Higher priority widgets stay visible longer
   * @param {InsertPosition|null} where - Position for insertAdjacentElement
   * @param {HTMLElement|null} referenceElement - Reference element for positioning
   * @returns {string} The widget ID
   */
  _addWidget(widget, priority, where = null, referenceElement = null) {
    const widgetId = widget.id || `widget-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    widget.id = widgetId;
    widget.dataset.priority = String(priority);

    this.widgets.set(widgetId, { element: widget, priority });
    
    if (where && referenceElement) {
      referenceElement.insertAdjacentElement(where, widget);
    } else if (where) {
      this.insertAdjacentElement(where, widget);
    } else {
      this.appendChild(widget);
    }
    
    // Reapply flex layout if in flex mode (for ToolBar)
    if (this.tagName === 'TOOL-BAR' && this.getAttribute('smart-overflow') === 'off') {
      setTimeout(() => {
        const inputElements = this.querySelectorAll('sl-select, sl-input, sl-textarea, input, textarea');
        inputElements.forEach(element => {
          if (element instanceof HTMLElement) {
            element.style.flex = '1 1 auto';
            element.style.minWidth = '80px';
            element.style.width = 'auto';
          }
        });
        
        const fixedElements = this.querySelectorAll('sl-button, button, sl-button-group, sl-icon-button, sl-badge, sl-switch');
        fixedElements.forEach(element => {
          if (element instanceof HTMLElement) {
            element.style.flex = '0 0 auto';
          }
        });
      }, 50);
    }
    
    // Check for overflow after adding (delay to let all widgets be added)
    setTimeout(() => this.checkAndResolveOverflow(), 200);
    
    return widgetId;
  }

  /**
   * Add a widget to the panel
   * @param {HTMLElement} widget - The widget element
   * @param {number} priority - Higher priority widgets stay visible longer (default: 0)
   * @param {InsertPosition} [where] - Position for insertAdjacentElement ('beforebegin', 'afterbegin', 'beforeend', 'afterend'). Defaults to "beforeEnd"
   */
  add(widget, priority = 0, where = "beforeend") {
    return this._addWidget(widget, priority, where);
  }

  /**
   * Add a widget before another widget
   * @param {HTMLElement} widget - The widget element to add
   * @param {number} priority - Higher priority widgets stay visible longer (default: 0)
   * @param {HTMLElement} siblingWidget - The sibling widget to add before
   */
  addBefore(widget, priority = 0, siblingWidget) {
    return this._addWidget(widget, priority, 'beforebegin', siblingWidget);
  }

  /**
   * Add a widget after another widget
   * @param {HTMLElement} widget - The widget element to add
   * @param {number} priority - Higher priority widgets stay visible longer (default: 0)
   * @param {HTMLElement} siblingWidget - The sibling widget to add after
   */
  addAfter(widget, priority = 0, siblingWidget) {
    return this._addWidget(widget, priority, 'afterend', siblingWidget);
  }

  /**
   * Remove a widget from the panel
   * @param {string} widgetId - The ID of the widget to remove
   */
  removeById(widgetId) {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    const { element } = widget;
    
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
   * Clear all widgets from the panel
   */
  clearWidgets() {
    this.widgets.forEach((widget) => {
      if (widget.element.parentNode === this) {
        this.removeChild(widget.element);
      }
    });
    
    this.widgets.clear();
    this.hiddenWidgets.clear();
  }

  /**
   * Get all widgets
   */
  getWidgets() {
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

    // Re-check overflow after priority change
    setTimeout(() => this.checkAndResolveOverflow(), 0);

    return true;
  }
}

export { BasePanel };
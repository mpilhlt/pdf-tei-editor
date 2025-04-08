export function $(selector) {
  const node = document.querySelector(selector)
  if (!node) {
    throw new Error(`Selector "${selector} does not find any element"`)
  } 
  return node
}

export function $$(selector) {
  return document.querySelectorAll(selector)
}

export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[$]/g, '\\$&');
}

export function addBringToForegroundListener(selectors) {
  document.addEventListener('click', function (event) {
    let elements = [];
    selectors.forEach(selector => elements = elements.concat(Array.from($$(selector))));
    let targetElement = elements.find(elem => elem.contains(event.target))
    if (targetElement) {
      let highestZIndex = elements.reduce((acc, elem) => {
        let zIndex = parseInt(window.getComputedStyle(elem).zIndex);
        return zIndex > acc ? zIndex : acc;
      }, 0);
      targetElement.style.zIndex = highestZIndex + 1;
    }
  });
}

export function makeDraggable(element) {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;
  const { height, width } = window.getComputedStyle(element);
  element.style.cursor = 'grab';

  element.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = element.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    element.style.cursor = 'grabbing'; // Change cursor while dragging
    element.style.userSelect = 'none'; // Prevent text selection during drag
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    element.style.left = x + 'px';
    element.style.top = y + 'px';
    element.style.right = (x + width) + 'px';
    element.style.top = (y + height) + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    element.style.cursor = 'grab'; // Restore cursor after dragging
    element.style.userSelect = 'auto'; // Restore text selection
  });

  // document.addEventListener('mouseleave', () => {
  //   if (isDragging) {
  //     isDragging = false;
  //     element.style.cursor = 'grab'; // Restore cursor after dragging
  //     element.style.userSelect = 'auto'; // Restore text selection
  //   }
  // });
}
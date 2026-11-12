/**
 * Table of contents drop-up and heading links for drawers showing rendered
 * Markdown (annotation guide, user manual). The drop-up is an `sl-dropdown`
 * with `placement="top-start"` in the drawer footer whose `sl-menu` lists the
 * document's headings (see `extractHeadings()` in markdown-utils.js).
 */

/**
 * @import { SlDrawer, SlDropdown, SlMenu } from '../ui.js'
 * @import { MarkdownHeading } from './markdown-utils.js'
 */

/**
 * Rebuilds a TOC menu from the given headings, indenting each entry by its
 * level relative to the topmost level present (whose entries are bold if
 * there are deeper levels). Each item's value is the index of its heading.
 * Hides `dropdown` if there are no headings.
 * @param {SlDropdown} dropdown - The drop-up containing `menu`
 * @param {SlMenu} menu - The menu to fill
 * @param {MarkdownHeading[]} headings
 */
export function populateTocMenu(dropdown, menu, headings) {
  menu.replaceChildren()
  const minLevel = Math.min(...headings.map(h => h.level))
  const nested = headings.some(h => h.level !== minLevel)
  headings.forEach((heading, index) => {
    const item = document.createElement('sl-menu-item')
    item.value = String(index)
    item.dataset.level = String(heading.level)
    const label = document.createElement('span')
    label.style.display = 'block'
    label.style.paddingLeft = `${(heading.level - minLevel) * 1.25}rem`
    if (nested && heading.level === minLevel) label.style.fontWeight = '600'
    label.textContent = heading.text
    item.append(label)
    menu.append(item)
  })
  dropdown.hidden = headings.length === 0
}

/**
 * Limits a TOC menu to the size of the drawer's scrollable body, so that the
 * menu shows the whole TOC and only scrolls if it would be taller than the
 * drawer content. Call it on the dropdown's `sl-show`.
 * @param {SlDrawer} drawer
 * @param {SlMenu} menu
 */
export function fitTocMenu(drawer, menu) {
  const body = /** @type {HTMLElement | null} */ (drawer.shadowRoot?.querySelector('[part="body"]'))
  if (!body) return
  // sl-dropdown sizes a slotted sl-menu with an !important max-height/width
  // from these properties, which it inherits from the popup; overriding them
  // on the menu is the only way to change that. The space above the trigger
  // is always at least the body height, so the menu still fits the viewport.
  menu.style.setProperty('--auto-size-available-height', `${body.clientHeight}px`)
  menu.style.setProperty('--auto-size-available-width', `${body.clientWidth}px`)
}

/**
 * Scrolls to the rendered heading of a TOC entry.
 * @param {HTMLElement} container - The element containing the rendered Markdown
 * @param {MarkdownHeading} heading
 * @returns {boolean} Whether the heading was found
 */
export function scrollToHeading(container, heading) {
  const candidates = container.querySelectorAll(`[id="${CSS.escape(heading.anchor)}"]`)
  const target = candidates[heading.occurrence] || candidates[0]
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return true
}

/**
 * Adds a "Copy link" button to each heading with an id, shown when the
 * pointer is over the heading (styled by `.heading-link` in app.css).
 * @param {HTMLElement} container - The element containing the rendered Markdown
 * @param {(anchor: string) => void} onCopy - Called with the heading's id when its button is clicked
 */
export function addHeadingLinkButtons(container, onCopy) {
  container.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]').forEach(heading => {
    // written as markup so that the icon build (scripts/build/compile-sl-icons.py) finds the icon name
    heading.insertAdjacentHTML('beforeend', '<sl-icon-button class="heading-link" name="link-45deg" label="Copy link" title="Copy link"></sl-icon-button>')
    const button = /** @type {HTMLElement} */ (heading.lastElementChild)
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      onCopy(heading.id)
    })
  })
}

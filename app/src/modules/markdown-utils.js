/**
 * Utilities for rendering and processing markdown content
 */

/**
 * @import MarkdownIt from 'markdown-it'
 */
import markdownit from 'markdown-it'
import markdownItContainer from 'markdown-it-container'

/**
 * Admonition type configuration
 * Maps both container types (:::info) and GFM alert types ([!NOTE]) to styling
 */
const admonitionConfig = {
  info: { icon: 'info-circle', colorVar: 'accent', gfmType: 'NOTE' },
  tip: { icon: 'lightbulb', colorVar: 'accent', gfmType: 'TIP' },
  warning: { icon: 'exclamation-triangle', colorVar: 'attention', gfmType: 'WARNING' },
  important: { icon: 'exclamation-circle', colorVar: 'danger', gfmType: 'IMPORTANT' },
  caution: { icon: 'exclamation-octagon', colorVar: 'danger', gfmType: 'CAUTION' },
  success: { icon: 'check-circle', colorVar: 'success', gfmType: null },
  danger: { icon: 'x-octagon', colorVar: 'danger', gfmType: null },
  note: { icon: 'info-circle', colorVar: 'accent', gfmType: 'NOTE' }
}

/**
 * Renders opening tag for an admonition block
 * @param {string} type - The admonition type (info, warning, etc.)
 * @returns {string} Opening HTML
 */
function renderAdmonitionOpen(type) {
  const config = admonitionConfig[type] || admonitionConfig.info
  return `<div class="admonition admonition-${type}" style="
    border-left: 4px solid var(--borderColor-${config.colorVar}-emphasis);
    background-color: var(--bgColor-muted);
    padding: 1rem;
    margin: 1rem 0;
    border-radius: 4px;
    display: flex;
    gap: 0.75rem;
  ">
    <div style="flex-shrink: 0; color: var(--fgColor-${config.colorVar}); font-size: 1.25rem; line-height: 1.5;">
      <sl-icon name="${config.icon}"></sl-icon>
    </div>
    <div class="admonition-content" style="flex: 1;">
`
}

/**
 * Renders closing tag for an admonition block
 * @returns {string} Closing HTML
 */
function renderAdmonitionClose() {
  return '</div></div>\n'
}

/**
 * Creates a configured markdown-it instance with admonitions and TOC support
 * @returns {MarkdownIt} Configured markdown renderer
 */
export function createMarkdownRenderer() {
  const options = {
    html: true,
    linkify: true,
    typographer: true
  }
  const md = markdownit(options)

  // Add support for container-style admonitions (:::info, :::warning, etc.)
  Object.keys(admonitionConfig).forEach(type => {
    md.use(markdownItContainer, type, {
      render: (tokens, idx) => {
        if (tokens[idx].nesting === 1) {
          // Opening tag
          return renderAdmonitionOpen(type)
        } else {
          // Closing tag
          return renderAdmonitionClose()
        }
      }
    })
  })

  // Add support for GitHub-style alerts (> [!NOTE])
  const defaultBlockquoteRender = md.renderer.rules.blockquote_open || function(tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

  md.renderer.rules.blockquote_open = (tokens, idx, options, _env, self) => {
    // Check if next token is a paragraph containing a GFM alert marker
    const nextToken = tokens[idx + 1]
    if (nextToken && nextToken.type === 'paragraph_open') {
      const contentToken = tokens[idx + 2]
      if (contentToken && contentToken.type === 'inline') {
        const alertMatch = contentToken.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/)
        if (alertMatch) {
          const gfmType = alertMatch[1]
          // Find matching admonition type
          const type = Object.keys(admonitionConfig).find(
            key => admonitionConfig[key].gfmType === gfmType
          ) || 'info'

          // Remove the alert marker from content
          contentToken.content = contentToken.content.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/, '')

          // Mark this blockquote as an alert for closing
          tokens[idx].attrSet('data-alert-type', type)

          return renderAdmonitionOpen(type)
        }
      }
    }
    return defaultBlockquoteRender(tokens, idx, options, _env, self)
  }

  const defaultBlockquoteCloseRender = md.renderer.rules.blockquote_close || function(tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

  md.renderer.rules.blockquote_close = (tokens, idx, options, _env, self) => {
    // Check if this is closing an alert blockquote
    const openToken = tokens.slice(0, idx).reverse().find(t => t.type === 'blockquote_open')
    if (openToken && openToken.attrGet('data-alert-type')) {
      return renderAdmonitionClose()
    }
    return defaultBlockquoteCloseRender(tokens, idx, options, _env, self)
  }

  // Add automatic heading IDs for TOC links
  const defaultHeadingRender = md.renderer.rules.heading_open || function(tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    const contentToken = tokens[idx + 1]

    if (contentToken && contentToken.type === 'inline') {
      const text = contentToken.content
      // Generate anchor from heading text
      const anchor = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
      token.attrSet('id', anchor)
    }

    return defaultHeadingRender(tokens, idx, options, _env, self)
  }

  return md
}

/**
 * Fetches markdown content from a URL
 * @param {string} url - URL to fetch markdown from
 * @param {boolean} enableCache - Whether to enable browser caching
 * @returns {Promise<string>} The markdown content
 * @throws {Error} If fetch fails
 */
export async function fetchMarkdown(url, enableCache = true) {
  const fetchOptions = enableCache ? {} : { cache: 'no-cache' }
  const response = await fetch(url, fetchOptions)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`)
  }
  return await response.text()
}

/**
 * Processes rendered HTML to handle links and images
 * @param {string} html - Rendered HTML from markdown
 * @param {object} options - Processing options
 * @param {string} options.localLinkHandler - JavaScript function name to call for local links
 * @param {string} [options.imagePrefix] - Prefix to add to relative image paths
 * @param {boolean} [options.openExternalInNewTab=true] - Whether to open external links in new tabs
 * @returns {string} Processed HTML
 */
export function processMarkdownHtml(html, options) {
  const {
    localLinkHandler,
    imagePrefix,
    openExternalInNewTab = true
  } = options

  let processed = html

  // Replace local links with JavaScript handler calls
  if (localLinkHandler) {
    processed = processed.replaceAll(
      /(<a\s+.*?)href=(["'])((?!https?:\/\/|\/\/|#).*?)\2(.*?>)/g,
      `$1href="#" onclick="${localLinkHandler}('$3'); return false"$4`
    )
  }

  // Add prefix to relative image paths
  if (imagePrefix) {
    processed = processed.replaceAll(
      /src="(\.\/)?images\//g,
      `src="${imagePrefix}/images/`
    )
  }

  // Open external links in new tabs
  if (openExternalInNewTab) {
    processed = processed.replaceAll(
      /(href="http)/g,
      `target="_blank" $1`
    )
  }

  // Remove comment tags that mask Shoelace components
  processed = processed.replaceAll(/<!--|-->/gs, '')

  return processed
}

/**
 * Generates a table of contents from markdown headings
 * @param {string} markdown - Markdown content to analyze
 * @returns {string} HTML list of linked headings
 */
export function generateTOC(markdown) {
  const headings = []
  const lines = markdown.split('\n')

  lines.forEach(line => {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      // Create anchor from heading text (lowercase, replace spaces with hyphens)
      const anchor = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
      headings.push({ level, text, anchor })
    }
  })

  if (headings.length === 0) {
    return '<p><em>No headings found</em></p>'
  }

  // Build nested list
  let html = '<nav class="toc" style="background-color: var(--bgColor-muted); padding: 1rem; border-radius: 4px; margin: 1rem 0;">\n'
  html += '<div style="font-weight: 600; margin-bottom: 0.5rem;">Table of Contents</div>\n'
  html += '<ul style="list-style: none; padding-left: 0; margin: 0;">\n'

  headings.forEach(({ level, text, anchor }) => {
    const indent = (level - 1) * 1.5
    html += `<li style="margin-left: ${indent}rem; margin-top: 0.25rem;">
      <a href="#${anchor}" style="color: var(--fgColor-accent); text-decoration: none;">
        ${text}
      </a>
    </li>\n`
  })

  html += '</ul>\n</nav>'
  return html
}

/**
 * Renders markdown to HTML with standard processing
 * @param {MarkdownIt} md - Markdown renderer instance
 * @param {string} markdown - Markdown content to render
 * @param {object} options - Processing options (see processMarkdownHtml)
 * @returns {string} Processed HTML
 */
export function renderMarkdown(md, markdown, options) {
  // Replace TOC placeholder with generated table of contents (case-insensitive)
  const TOC_REGEX = /^(\[TOC\]|\[toc])$/m
  let processedMarkdown = markdown
  if (TOC_REGEX.test(markdown)) {
    const toc = generateTOC(markdown)
    processedMarkdown = markdown.replace(TOC_REGEX, toc)
  }

  const html = md.render(processedMarkdown)
  return processMarkdownHtml(html, options)
}

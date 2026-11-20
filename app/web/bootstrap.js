/**
 * Script for bootstrapping the application, or another entry point given by the `data-entry` attribute of the
 * script tag (e.g. `<script src="/bootstrap.js" data-entry="manual">` for the manual window, app/web/manual.html, and
 * `data-entry="guide"` for the annotation guide window, app/web/guide.html).
 * Pages other than the application are served below other paths, so their resources are loaded from absolute URLs.
 */

const entry = document.currentScript?.dataset.entry || 'app'
const root = entry === 'app' ? './' : '/'


// check whether we are supposed to run the source or the built version
const loadFromSource = new URLSearchParams(window.location.search).has('dev')

// point the favicon at the dev (amber) or production (blue) variant;
// runs synchronously so the correct icon shows before first paint
const faviconBase = loadFromSource ? 'favicon-dev' : 'favicon'
let svgIcon = document.querySelector('link[rel="icon"][type="image/svg+xml"]')
if (!svgIcon) {
  svgIcon = document.createElement('link')
  svgIcon.rel = 'icon'
  svgIcon.type = 'image/svg+xml'
  document.head.appendChild(svgIcon)
}
svgIcon.href = `${root}${faviconBase}.svg`

let icoIcon = document.querySelector('link[rel="icon"][sizes="any"]')
if (!icoIcon) {
  icoIcon = document.createElement('link')
  icoIcon.rel = 'icon'
  icoIcon.sizes = 'any'
  document.head.appendChild(icoIcon)
}
icoIcon.href = `${root}${faviconBase}.ico`

window.addEventListener('DOMContentLoaded', async () => {
  if (loadFromSource) {
    // add importmap 
    let response = await fetch(`${root}importmap.json`)
    let importMap = await response.json()
    if (entry !== 'app') {
      // the paths in the importmap are relative to the application page at the root
      importMap = JSON.parse(JSON.stringify(importMap).replaceAll('"../../', '"/'))
    }
    const script = document.createElement('script');
    script.type = 'importmap';
    script.textContent = JSON.stringify(importMap, null, 2);
    document.head.appendChild(script);

    // inject a shoelace bootstrap script
    const shoelaceScript = document.createElement('script');
    shoelaceScript.type = 'module';
    shoelaceScript.textContent = `
        import { setBasePath } from '/node_modules/@shoelace-style/shoelace/dist/utilities/base-path.js';
        setBasePath('/node_modules/@shoelace-style/shoelace/dist/');
      `
    document.body.appendChild(shoelaceScript);
  }

  // add shoelace css
  const shoelaceCss = document.createElement('link');
  shoelaceCss.rel = 'stylesheet';
  shoelaceCss.href = loadFromSource
    ? '/node_modules/@shoelace-style/shoelace/dist/themes/light.css'
    : `${root}light.css`;
  document.head.appendChild(shoelaceCss);

  if (entry !== 'app') {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = loadFromSource ? `/src/${entry}.js` : `/${entry}.js`;
    document.body.appendChild(script);
    return
  }

  // add PDF.js viewer css
  const pdfjsCss = document.createElement('link');
  pdfjsCss.rel = 'stylesheet';
  pdfjsCss.href = loadFromSource
    ? '/node_modules/pdfjs-dist/web/pdf_viewer.css'
    : '/pdfjs/web/pdf_viewer.css';
  document.head.appendChild(pdfjsCss);

  // load the main script as an esm module
  const mainScript = document.createElement('script');
  mainScript.type = 'module';
  mainScript.src = loadFromSource ? '/src/app.js' : 'app.js';
  document.body.appendChild(mainScript);
})




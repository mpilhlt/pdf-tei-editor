/**
 * Script for bootstrapping the application
 */


// check whether we are supposed to run the source or the built version
const loadFromSource = new URLSearchParams(window.location.search).has('dev')

window.addEventListener('DOMContentLoaded', async () => {
  if (loadFromSource) {
    // add importmap 
    let response = await fetch('./importmap.json')
    let importMap = await response.json()
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
    : 'light.css';
  document.head.appendChild(shoelaceCss);

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




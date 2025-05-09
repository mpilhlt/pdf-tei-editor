/**
 * Script for bootstrapping the application
 */

(async () => {

  // add importmap 
  let response = await fetch('./importmap.json')
  let importMap = await response.json()
  const script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify(importMap, null, 2);
  document.head.appendChild(script);

  // add shoelace css
  const shoelaceCss = document.createElement('link');
  shoelaceCss.rel = 'stylesheet';
  shoelaceCss.href = '/node_modules/@shoelace-style/shoelace/dist/themes/light.css';
  document.head.appendChild(shoelaceCss);

  // inject a shoelace bootstrap script
  const shoelaceScript = document.createElement('script');
  shoelaceScript.type = 'module';
  shoelaceScript.textContent = `
    import { setBasePath } from '/node_modules/@shoelace-style/shoelace/dist/utilities/base-path.js';
    setBasePath('/node_modules/@shoelace-style/shoelace/dist/');
  `
  document.body.appendChild(shoelaceScript);

  // load the main script as an esm module
  const mainScript = document.createElement('script');
  mainScript.type = 'module';
  mainScript.src = '/src/app.js';
  document.body.appendChild(mainScript);
})()



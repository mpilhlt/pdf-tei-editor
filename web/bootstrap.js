// load the importmap
fetch('./importmap.json')
.then(response => response.json())
.then(importMap => {
  const script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify(importMap, null, 2);
  document.head.appendChild(script);

  // xmllint 
  const xmllintscript = document.createElement('script');
  xmllintscript.src = '/node_modules/xmllint/xmllint.js'; 
  document.body.appendChild(xmllintscript);

  // Now, load the main script that uses the import map
  const mainScript = document.createElement('script');
  mainScript.type = 'module';
  mainScript.src = '/src/app.js'; 
  document.body.appendChild(mainScript);
})
.catch(error => console.error('Error loading import map:', error));

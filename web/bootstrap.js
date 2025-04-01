// load the importmap
fetch('./importmap.json')
.then(response => response.json())
.then(importMap => {
  const script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify(importMap, null, 2);
  document.head.appendChild(script);

  // Now, load the main script that uses the import map
  const mainScript = document.createElement('script');
  mainScript.type = 'module';
  mainScript.src = '/src/app.js'; 
  document.body.appendChild(mainScript);
})
.catch(error => console.error('Error loading import map:', error));

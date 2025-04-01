// generate-import-map.js
const glob = require('glob')
const fs = require('fs')

const nodeModulesPath = './node_modules';
const outputPath = './web/importmap.json';

const importMap = { imports: {} };

// Synchronously find all 'dist/index.js' files within node_modules
const files = glob.sync(`${nodeModulesPath}/**/{src,dist}/index.{mjs,js}`);

files.forEach(file => {
  // Extract the package name from the path
  const parts = file.split('/');
  let packageName;
  let packageScope;

  if (file.includes('@')) { // Scoped package (e.g., @codemirror/state)
     packageName = parts[parts.findIndex(part => part.startsWith('@'))+1];
     packageScope = parts[parts.findIndex(part => part.startsWith('@'))]
     packageName = `${packageScope}/${packageName}`
  } else {
      packageName = parts[parts.findIndex(part => part === 'node_modules') + 1];
  }

  // Create the import map entry
  importMap.imports[packageName] = `/${file}`; // Important leading slash!
});

// manual additions
importMap.imports["style-mod"] = "/node_modules/style-mod/src/style-mod.js"
importMap.imports["w3c-keyname"] = "/node_modules/w3c-keyname/index.js"
importMap.imports["crelt"] = "/node_modules/crelt/index.js"


console.log(importMap)

// Write the import map to a file
fs.writeFileSync(outputPath, JSON.stringify(importMap, null, 2));

console.log(`Import map generated at ${outputPath}`);
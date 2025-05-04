//import '@shoelace-style/shoelace/dist/components/select/select.js';

import { app, PdfTeiEditor } from '../app.js'
import { XMLEditor } from './xmleditor.js'
import { setSelectboxIndex } from '../modules/browser-utils.js'

const commandBarDiv = document.querySelector('#command-bar')

const html = `
<div id="command-bar">
  <select id="select-doc" name="pdf"></select><br/>
  Version: <select id="select-version" name="xml"></select>
  Diff: <select id="select-diff-version" name="diff"></select>
  Extract: 
  <button id="btn-load-document" name="load">New</button>
  <button id="btn-extract" name="extract">Current</button>
  <div> </div>
  <button id="btn-validate-document" name="validate" disabled>Validate</button>  
  <button id="btn-save-document" name="save" disabled>Save</button> 
  <button id="btn-cleanup" name="cleanup" disabled>Cleanup</button>  
</div>
`
commandBarDiv.outerHTML = html.trim()

/**
 * component API
 */
export const commandBarComponent = {
  /**
   * Add an element
   * @param {Element} element 
   * @param {string} name
   */
  add: (element, name) => {
    if (name) {
      element.name = name
    }
    commandBarDiv.appendChild(element)
  },

  /**
   * Add an element at the specific index
   * @param {Element} element 
   * @param {Number} index 
   * @param {string} name
  */
  addAt: (element, index, name) => {
    if (name) {
      element.name = name
    }
    commandBarDiv.insertBefore(element, commandBarDiv.childNodes[index])
  },

  /**
   * Returns the child element of that name
   * @param {string} name The name of the child element
   * @returns {Element}
   */
  getByName: name => {
    const namedElems = commandBarDiv.querySelectorAll(`[name="${name}"]`)
    if (namedElems.length === 1) {
      return namedElems[0]
    }
    throw new Error(`No or more than one child element with the name "${name}"`)
  },

  /**
   * Updates data such as select box options
   */
  update: async () => {
    await reloadFileData()
    populateSelectboxes()
  }
}

// UI elements
const pdfSelectbox = commandBarComponent.getByName('pdf')
const xmlSelectbox = commandBarComponent.getByName('xml')
const diffSelectbox = commandBarComponent.getByName('diff')

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent('command-bar', commandBarComponent, 'commandbar')

  // configure prepopulated elements
  populateSelectboxes()
  setupEventHandlers()

  // bind selectboxes to app state
  app.on("change:pdfPath", (value, old) => {
    setSelectboxIndex(pdfSelectbox, value)
  })
  app.on("change:xmlPath", (value, old) => {
    setSelectboxIndex(xmlSelectbox, value)
  })
  app.on("change:diffXmlPath", (value, old) => {
    setSelectboxIndex(diffSelectbox, value)
  })

  // enable save button on dirty editor
  app.xmleditor.addEventListener(XMLEditor.EVENT_XML_CHANGED, event => {
    commandBarComponent.getByName('save').disabled = false
  });
  console.log("Command bar plugin installed.")
}

/**
 * component plugin
 */
export const commandBarPlugin = {
  name: "command-bar",
  app: { start }
}

export default commandBarPlugin

//
// setup the selectboxes
//




/**
 * The data about the pdf and xml files on the server
 */
let fileData = null;

async function reloadFileData() {
  const { files } = await app.client.getFileList();
  fileData = files
}

// Populates the selectbox for file name and version
function populateSelectboxes() {

  // Clear existing options
  pdfSelectbox.innerHTML = xmlSelectbox.innerHTML = diffSelectbox.innerHTML = '';

  // Populate file select box 
  fileData.forEach(file => {
    const option = document.createElement('option');
    option.value = file.id;
    option.text = file.label
    if (file.pdf === pdfPath) {
      option.selected = true
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          const option = document.createElement('option');
          option.value = version.path;
          option.text = version.label;
          option.selected = (version.path === app.xmlPath)
          xmlSelectbox.appendChild(option);
          const diffOption = option.cloneNode(true)
          diffOption.selected = (version.path === app.diffXmlPath)
          diffSelectbox.appendChild(diffOption)
        })
      }
    }
    pdfSelectbox.appendChild(option);
  })
}

//
// UI event handlers
// 

function setupEventHandlers() {

  // file selectboxes
  pdfSelectbox.addEventListener('change', onChangePdfSelectbox);
  xmlSelectbox.addEventListener('change', onChangeXmlSelectbox);
  diffSelectbox.addEventListener('change', onChangeDiffSelectbox);

  // load new document
  commandBarComponent.getByName('load').addEventListener('click', onClickLoadDocument)

  // extract from current PDF
  commandBarComponent.getByName('extract').addEventListener('click', onClickExtractBtn)

  // validate xml button
  const validateBtn = commandBarComponent.getByName('validate')
  validateBtn.addEventListener('click', onClickValidateButton);
  validationEvents.addEventListener(validationEvents.EVENT.START, () => {
    validateBtn.innerHTML = "Validating XML..."
    validateBtn.disabled = true;
  })
  validationEvents.addEventListener(validationEvents.EVENT.END, () => {
    validateBtn.innerHTML = "Validate"
    validateBtn.disabled = false;
  })

  // save current version
  commandBarComponent.getByName('save').addEventListener('click', onClickSaveButton);

  // cleanup
  const cleanupBtn = commandBarComponent.getByName("cleanup")
  cleanupBtn.addEventListener('click', onClickBtnCleanup)
  cleanupBtn.disabled = xmlSelectbox.options.length < 2
}


// listen for changes in the PDF selectbox
async function onChangePdfSelectbox() {
  const selectedFile = fileData.find(file => file.id === pdfSelectbox.value);
  const pdf = selectedFile.pdf
  const xml = selectedFile.xml
  const filesToLoad = {}

  if (pdf && pdf !== pdfPath) {
    filesToLoad.pdf = pdf
  }
  if (xml && xml !== xmlPath) {
    filesToLoad.xml = xml
  }

  if (Object.keys(filesToLoad).length > 0) {
    try {
      await app.services.load(filesToLoad)
    }
    catch (error) {
      console.error(error)
    }
  }
}


// listen for changes in the version selectbox  
async function onChangeXmlSelectbox() {
  const xml = xmlSelectbox.value
  if (xml !== xmlPath) {
    try {
      await app.services.load({ xml })
    } catch (error) {
      console.error(error)
    }
  }
}

// listen for changes in the diff version selectbox  
async function onChangeDiffSelectbox() {
  const diff = diffSelectbox.value
  const isDiff = diff && diff !== xmlPath
  if (isDiff) {
    try {
      await app.services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    app.services.removeMergeView()
  }
}

async function onClickLoadDocument() {
  try {
    const { type, filename } = await app.client.uploadFile();
    switch (type) {
      case "xml":
        window.app.dialog.error("Loading XML documents not implemented yet.")
        break
      case "pdf":
        try {
          const doi = app.services.getDoiFromFilenameOrUserInput(filename)
          const { xml, pdf } = await app.services.extractFromPDF(filename, doi)
          await load({ xml, pdf })
        } catch (error) {
          console.error(error)
        }

        break;
    }
  } catch (error) {
    console.error('Error uploading file:', error);
  }
}

async function onClickValidateButton() {
  commandBarComponent.getByName('validate').disabled = true
  await app.services.validateXml()
}

async function onClickSaveButton() {
  const xmlPath = xmlSelectbox.value;
  await app.services.saveXml(xmlPath)
  commandBarComponent.getByName('save').disabled = true
}

async function onClickExtractBtn() {
  let doi;
  try {
    doi = app.services.getDoiFromXml()
  } catch (error) {
    console.warn("Cannot get DOI from document:", error.message)
  }
  try {
    doi = doi || app.services.getDoiFromFilenameOrUserInput(app.pdfPath)
    let { xml } = await app.services.extractFromPDF(app.pdfPath, doi)
    await reloadFileData()
    await app.services.showMergeView(xml)
  } catch (error) {
    console.error(error)
  }
}

async function onClickBtnCleanup() {
  const msg = "Are you sure you want to clean up the extraction history? This will delete all versions of this document and leave only the current gold standard version."
  if (!confirm(msg)) return;
  const options = Array.from(xmlSelectbox.options)
  const filePathsToDelete = options
    .slice(1) // skip the first option, which is the gold standard version  
    .map(option => option.value)
  app.services.removeMergeView()
  if (filePathsToDelete.length > 0) {
    await app.client.deleteFiles(filePathsToDelete)
  }
  try {
    await reloadFileData()
    populateSelectboxes()
    // load the gold version
    await load({ xml: options[0].value })
  } catch (error) {
    console.error(error)
  }
}
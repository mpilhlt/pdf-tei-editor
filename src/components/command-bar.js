//import '@shoelace-style/shoelace/dist/components/select/select.js';

import { app, PdfTeiEditor } from '../app.js'
import { XMLEditor } from './xmleditor.js'
import { selectByValue, selectByData, UrlHash } from '../modules/browser-utils.js'
import { validationEvents } from '../modules/lint.js' // Todo remove this dependency, use events instead

const componentId = "command-bar"

// component html
const html = `
<div id="${componentId}">
  <select name="pdf"></select><br/>
  Version: <select name="xml"></select>
  Diff: <select name="diff"></select>
  Extract: 
  <button name="load">New</button>
  <button name="extract">Current</button>
  <div> </div>
  <button name="validate" disabled>Validate</button>  
  <button name="save" disabled>Save</button> 
  <button name="cleanup" disabled>Cleanup</button>  
</div>
`
const div = document.createElement("div")
div.innerHTML = html.trim()
const targetNode = document.getElementById(componentId)
targetNode.parentNode.replaceChild(div.firstChild,targetNode)

// component node 
const componentNode = document.getElementById(componentId)

/**
 * component API
 */
const cmp = {
  /**
   * Add an element
   * @param {Element} element 
   * @param {string} name
   */
  add: (element, name) => {
    if (name) {
      element.name = name
    }
    componentNode.appendChild(element)
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
    componentNode.insertBefore(element, componentNode.childNodes[index])
  },

  /**
   * Returns the child element of that name
   * @param {string} name The name of the child element
   * @returns {Element}
   */
  getByName: name => {
    const namedElems = componentNode.querySelectorAll(`[name="${name}"]`)
    if (namedElems.length === 1) {
      return namedElems[0]
    }
    throw new Error(`No or more than one child element with the name "${name}"`)
  },

  /**
   * Attaches a click event handler to a named subelement of the component
   * @param {string} name The name of the element
   * @param {Function} handler The function to call when the element is clicked
   */
  clicked: (name, handler) => {
    cmp.getByName(name).addEventListener('click', handler)
  },

  /**
   * Updates data such as select box options based on the application state
   */
  update: async () => {
    populateSelectboxes()
  },

  /**
   * Reloads data and then updates based on the application state
   */
  reload: async () => {
    await reloadFileData()
    populateSelectboxes()
  },

  /**
   * Returns the option that is selected in the selectbox with the given name
   * @param {string} name The name of the selectbox
   * @returns {HTMLOptionElement}
   */
  selectedOption: name => {
    const select = cmp.getByName(name)
    if (!select || select.options === undefined) {
      throw new Error(`Element with name "${name}" is not a selectbox`)
    }
    if (select.options.length === 0) {
      throw new Error(`Element with name "${name}" has no options`)
    }
    return select.options[select.selectedIndex]
  }
}

// UI elements
const pdfSelectbox = cmp.getByName('pdf')
const xmlSelectbox = cmp.getByName('xml')
const diffSelectbox = cmp.getByName('diff')

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent(componentId, cmp, "commandbar")

  // configure prepopulated elements
  setupEventHandlers()

  // bind selectboxes to app state
  app.on("change:pdfPath", (value, old) => {
    if (value) selectByValue(pdfSelectbox, value)
  })
  app.on("change:xmlPath", (value, old) => {
    if (value) selectByValue(xmlSelectbox, value)
  })
  app.on("change:diffXmlPath", (value, old) => {
    if (value) selectByValue(diffSelectbox, value)
  })

  // enable save button on dirty editor
  app.xmleditor.addEventListener(
    XMLEditor.EVENT_XML_CHANGED, 
    () => cmp.getByName('save').disabled = false
  );
  console.log("Loading file metadata...")
  await cmp.reload()
  console.log("Command bar component installed.")
}

/**
 * component plugin
 */
const commandBarPlugin = {
  name: componentId,
  install
}

export { cmp as commandBarComponent, commandBarPlugin }
export default commandBarPlugin

//
// helper functions
//

/**
 * The data about the pdf and xml files on the server
 */
let fileData = null;

/**
 * Reloads the file data from the server
 */
async function reloadFileData() {
  const { files } = await app.client.getFileList();
  fileData = files
  if (!fileData || fileData.length === 0) {
    app.dialog.error("No files found")
  }
}

/**
 * Populates the selectboxes for file name and version
 */
function populateSelectboxes() {

  if (fileData === null) {
    throw new Error("You need to load the file data first")
  }

  // Clear existing options
  pdfSelectbox.innerHTML = xmlSelectbox.innerHTML = diffSelectbox.innerHTML = '';

  // get items to be selected from app state or use first element
  const pdfPath = app.pdfPath || fileData[0].pdf
  const xmlPath = app.xmlPath || fileData[0].xml
  const diffXmlPath = app.diffXmlPath || fileData[0].xml
      
  fileData.forEach(file => {

    // populate pdf select box 
    const option = document.createElement('option');
    option.value = file.pdf
    option.text = file.label

    if (file.pdf === pdfPath ) {
      option.selected = true
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          const option = document.createElement('option');
          option.value = version.path;
          option.text = version.label;
          option.selected = (version.path === xmlPath)
          xmlSelectbox.appendChild(option);
          const diffOption = option.cloneNode(true)
          diffOption.selected = (version.path === diffXmlPath)
          diffSelectbox.appendChild(diffOption)
        })
      }
    }
    pdfSelectbox.appendChild(option);
  })
}

/**
 * Attaches the event handlers to the component subelements
 */
function setupEventHandlers() {

  // file selectboxes
  pdfSelectbox.addEventListener('change', onChangePdfSelectbox);
  xmlSelectbox.addEventListener('change', onChangeXmlSelectbox);
  diffSelectbox.addEventListener('change', onChangeDiffSelectbox);

  // load new document
  cmp.clicked('load', onClickLoadDocument)

  // extract from current PDF
  cmp.clicked('extract', onClickExtractBtn)

  // validate xml button
  const validateBtn = cmp.getByName('validate')
  validateBtn.addEventListener('click', onClickValidateButton);
  // disable during an ongoing validation
  validationEvents.addEventListener(validationEvents.EVENT.START, () => {
    validateBtn.innerHTML = "Validating XML..."
    validateBtn.disabled = true;
  })
  validationEvents.addEventListener(validationEvents.EVENT.END, () => {
    validateBtn.innerHTML = "Validate"
    validateBtn.disabled = false;
  })

  // save current version
  cmp.clicked('save', onClickSaveButton);

  // cleanup
  const cleanupBtn = cmp.getByName("cleanup")
  cleanupBtn.addEventListener('click', onClickBtnCleanup)
  cleanupBtn.disabled = xmlSelectbox.options.length < 2
}


/**
 * Called when the selection in the PDF selectbox changes
 */
async function onChangePdfSelectbox() {
  const selectedFile = fileData.find(file => file.pdf === pdfSelectbox.value);
  const pdf = selectedFile.pdf
  const xml = selectedFile.xml
  const filesToLoad = {}

  if (pdf && pdf !== app.pdfPath) {
    filesToLoad.pdf = pdf
  }
  if (xml && xml !== app.xmlPath) {
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


/**
 * Called when the selection in the XML selectbox changes
 */
async function onChangeXmlSelectbox() {
  const xml = xmlSelectbox.value
  if (xml !== app.xmlPath) {
    try {
      await app.services.removeMergeView()
      await app.services.load({ xml })
    } catch (error) {
      console.error(error)
    }
  }
}

/**
 * Called when the selection in the diff version selectbox  changes
 */
async function onChangeDiffSelectbox() {
  const diff = diffSelectbox.value
  if (diff !== xmlSelectbox.value) {
    try {
      await app.services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    app.services.removeMergeView()
  }
}

/**
 * Called when the "Load" button is executed
 */
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

/**
 * Called when the "Validate" button is executed
 */
async function onClickValidateButton() {
  cmp.getByName('validate').disabled = true
  await app.services.validateXml()
}

/**
 * Called when the "Save" button is executed
 */
async function onClickSaveButton() {
  const xmlPath = xmlSelectbox.value;
  await app.services.saveXml(xmlPath)
  cmp.getByName('save').disabled = true
}

/**
 * Called when the "Extract" button is executed
 */
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

/**
 * Called when the "Cleanup" button is executed
 */
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
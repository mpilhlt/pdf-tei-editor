//import '@shoelace-style/shoelace/dist/components/select/select.js';

import { app, PdfTeiEditor } from '../app.js'
import { XMLEditor } from './xmleditor.js'
import { $ } from '../modules/browser-utils.js'

const commandBar = document.querySelector('#command-bar')

/**
 * component API
 */
export const commandBarComponent = {
  /**
   * Add an element
   * @param {Element} element 
   */
  add: (element, name) => {
    if (name) {
      element.name = name
    }
    commandBar.appendChild(element)
  },
  
  /**
   * Add an element at the specific index
   * @param {Element} element 
   * @param {Number} index 
  */
  addAt: (element, index, name) => {
    if (name) {
      element.name = name
    }    
    commandBar.insertBefore(element, commandBar.childNodes[index])
  },

  /**
   * Returns the child element of that name
   * @param {string} name The name of the child element
   * @returns {Element}
   */
  getByName: name => {
    const namedElems = commandBar.querySelectorAll(`[name="${name}"]`)
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
    populateFilesSelectboxes()
  }
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent('command-bar', commandBarComponent, 'commandbar')

  // configure prepopulated buttons
  
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

// UI elements
const fileSelectbox = $('#select-doc')
const versionSelectbox = $('#select-version')
const diffSelectbox = $('#select-diff-version')

/**
 * The data about the pdf and xml files on the server
 */
let fileData = null;

export async function reloadFileData() {
  const { files } = await app.client.getFileList();
  fileData = files
  // updatae state
}

// Populates the selectbox for file name and version
function populateFilesSelectboxes() {

  // Clear existing options
  fileSelectbox.innerHTML = versionSelectbox.innerHTML = diffSelectbox.innerHTML = '';

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
          option.selected = (version.path === xmlPath)
          versionSelectbox.appendChild(option);
          const diffOption = option.cloneNode(true)
          diffOption.selected = (diffOption.value === diffXmlPath)
          diffSelectbox.appendChild(diffOption)
        })
      }
    }
    fileSelectbox.appendChild(option);
  });

}

// Populates the selectbox for the xpath expressions that 
// control the navigation within the xml document
function populateXpathSelectbox() {
  const selectbox = $('#select-xpath');
  try {
    const data = [
      {
        "xpath": "//tei:biblStruct",
        "label": "<biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[@status='verified']",
        "label": "Verified <biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[not(@status='verified')]",
        "label": "Unverified <biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[@status='unresolved']",
        "label": "Unresolved <biblStruct>"
      },
      {
        "xpath": null,
        "label": "Custom XPath"
      }
    ];

    // Clear existing options
    selectbox.innerHTML = '';

    // Populate select box with options
    data.forEach(item => {
      const option = document.createElement('option');
      option.value = item.xpath || ''
      option.text = item.label
      option.disabled = item.xpath === null
      selectbox.appendChild(option);
    });

    // button to edit the xpath manually
    $('#btn-edit-xpath').addEventListener('click', () => {
      const custom = selectbox[selectbox.length - 1]
      const xpath = prompt("Enter custom xpath", custom.value)
      if (xpath && xpath.trim()) {
        custom.value = xpath
        custom.text = `Custom: ${xpath}`
        selectbox.selectedIndex = selectbox.length - 1
      }
    })

    // listen for changes in the selectbox
    selectbox.addEventListener('change', () => {
      // this triggers the selection via the window's `hashchange` event
      UrlHash.set("xpath", selectbox.value)
    });

  } catch (error) {
    console.error('Error populating xpath selectbox:', error);
  }
}

/**
 * Code to configure the initial state of the UI
 */
function setupCommandBar() {

  // populate the selectboxes and setup change handlers
  populateXpathSelectbox()
  populateFilesSelectboxes()

  fileSelectbox.addEventListener('change', onChangePdfSelectbox);
  versionSelectbox.addEventListener('change', onChangeVersionSelectbox);
  diffSelectbox.addEventListener('change', onChangeDiffSelectbox);

  // update selectbox according to the URL hash
  window.addEventListener('hashchange', onHashChange);

  // load new document
  $('#btn-load-document').addEventListener('click', onClickLoadDocument)

  // extract from current PDF
  $('#btn-extract').addEventListener('click', onClickExtractBtn)

  // validate xml button
  const validateBtn = $('#btn-validate-document')
  validateBtn.addEventListener('click', onClickValidateButton);
  validationEvents.addEventListener(validationEvents.EVENT.START, () => {
    validateBtn.innerHTML = "Validating XML..."
    validateBtn.disable();
  })
  validationEvents.addEventListener(validationEvents.EVENT.END, () => {
    validateBtn.innerHTML = "Validate"
    validateBtn.enable();
  })

  // save current version
  $('#btn-save-document').addEventListener('click', onClickSaveButton);

  // auto-search switch
  $('#switch-auto-search').addEventListener('change', onAutoSearchSwitchChange)

  // edit prompt
  $('#btn-edit-prompt').addEventListener('click', () => $('#dlg-prompt-editor').showModal())
  $('#prompt-editor').addEventListener('close', () => $('#dlg-prompt-editor').close())

  // cleanup
  $('#btn-cleanup').addEventListener('click', onClickBtnCleanup)
  $('#btn-cleanup').disabled = $('#select-version').options.length < 2

  //
  // UI event handlers
  // 

  // listen for changes in the PDF selectbox
  async function onChangePdfSelectbox() {
    const selectedFile = fileData.find(file => file.id === fileSelectbox.value);
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
        await load(filesToLoad)
      }
      catch (error) {
        console.error(error)
      }
    }
  }


  // listen for changes in the version selectbox  
  async function onChangeVersionSelectbox() {
    const xml = versionSelectbox.value
    if (xml !== xmlPath) {
      try {
        await load({ xml })
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
        await showMergeView(diff)
      } catch (error) {
        console.error(error)
      }
    } else {
      removeMergeView()
    }
  }

  async function onClickLoadDocument() {
    try {
      const { type, filename } = await uploadFile('/api/upload');
      switch (type) {
        case "xml":
          window.app.dialog.error("Loading XML documents not implemented yet.")
          break
        case "pdf":
          try {
            const doi = getDoiFromFilenameOrUserInput(filename)
            const { xml, pdf } = await extractFromPDF(filename, doi)
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
    $('#btn-validate-document').disable()
    await validateXml()
  }

  async function onClickSaveButton() {
    const xmlPath = $('#select-version').value;
    await saveXml(xmlPath)
    $('#btn-save-document').text('Saved').disable()
  }

  async function onClickExtractBtn() {
    const pdfPath = $('#select-doc').value;
    const fileData = (await app.client.getFileList()).files.find(file => file.id === pdfPath)
    if (!fileData) {
      window.app.dialog.error("No file selected")
      return
    }
    let doi;
    try {
      doi = getDoiFromXml()
    } catch (error) {
      console.warn(error.message)
    }
    const filename = fileData.pdf
    try {
      doi = doi || getDoiFromFilenameOrUserInput(filename)
      let { xml, pdf } = await extractFromPDF(filename, doi)
      let diff = xml
      await reloadFileData()
      await load({ pdf })
      await showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  }

  async function onClickBtnCleanup() {
    const msg = "Are you sure you want to clean up the extraction history? This will delete all versions of this document and leave only the current gold standard version."
    if (!confirm(msg)) return;
    const options = Array.from($('#select-version').options)
    const filePathsToDelete = options
      .slice(1) // skip the first option, which is the gold standard version  
      .map(option => option.value)
    removeMergeView()
    if (filePathsToDelete.length > 0) {
      await app.client.deleteFiles(filePathsToDelete)
    }
    xmlPath = options[0].value
    try {
      await reloadFileData()
      populateFilesSelectboxes()
      await load({ xml: xmlPath, pdf: pdfPath })
    } catch (error) {
      console.error(error)
    }
  }
}
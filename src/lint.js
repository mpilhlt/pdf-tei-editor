
import { remote_xmllint } from './client.js'
import { $ } from './utils.js'
import { resolveXPath } from './codemirror_utils.js'

let validationInProgress = false;
let validatedVersion = null;

export async function lintSource(view) {

  if (validationInProgress) {
    console.log("Not validating since it is still in progress...")
    return;
  }

  console.log("Validation in progress...")

  validatedVersion = window.xmlEditor.getDocumentVersion();
  $('#btn-save-document').innerHTML = "Validating XML..."
  $('#btn-save-document').disabled = true;
  
  // get text from document
  const doc = view.state.doc;
  const xml = doc.toString();
  if (xml == "") {
    return [];
  }

  // send XML to remote validation service
  const { errors } = await remote_xmllint(xml);

  // check if document has changed in the meantime
  if (validatedVersion != window.xmlEditor.getDocumentVersion()) {
    console.log("Document has changed, discarding validation result")
    // restart validation and hope it will succeed this time
    window.xmlEditor.validateXml()
    return;
  }

  // convert xmllint errors to Diagnostic objects
  const diagnostics = errors.map(error => {
    let from, to;
    if (error.line) {
      ({ from, to } = doc.line(error.line))
      from += error.col

    } else if (error.path) {
      // {"reason": "Unexpected child with tag 'tei:imprint' at position 4. Tag 'tei:title' expected.", 
      // "path": "/TEI/standOff/listBibl/biblStruct[8]/monogr"}  
      const pos = resolveXPath(view, error.path)
      if (!pos) {
        console.warn(`Could not locate ${error.path} in syntax tree.`)
        return null
      }
      ({ from, to } = pos);
    } else {
      console.warn("Invalid response from remote validation:", error)
      return null
    }
    return { from, to, severity: "error", message: error.reason };
  }).filter(Boolean);

  if (diagnostics.length > 0) {
    $('#btn-save-document').innerHTML = "Invalid Document"
    console.log(`${diagnostics.length} linter error(s) found.`)
  } else {
    // (re-)enable save button
    $('#btn-save-document').innerHTML = "Save Document"
    $('#btn-save-document').disabled = false;
  }

  // we're done
  validationInProgress = false;

  return diagnostics;
}

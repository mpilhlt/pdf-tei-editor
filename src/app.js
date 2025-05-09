/**
 * PDF-TEI-Editor (working title)
 * 
 * @author Christian Boulanger (@cboulanger), Max Planck Institute for Legal History and Legal Theory
 * @license 
 */

import { PdfTeiEditor, App } from "./modules/pdf-tei-editor.js";

/**
 * The application instance
 * @type {PdfTeiEditor}
 */
let app;

// instantiate and run app 
try {
  // store app in global variable for debugging
  app = window.app = new PdfTeiEditor()
  await app.start()
} catch (error) {
  console.error(error)
}

export {app, PdfTeiEditor, App}
export default app

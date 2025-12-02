/**
 * Application state management
 * 
 * This file contains the application state definition and initial state object.
 */

/**
 * @import { FileListItem } from './modules/file-data-utils'
 * @import { UserData } from './plugins/authentication'
 */

/**
 * Collection information
 * @typedef {object} CollectionInfo
 * @property {string} id - Unique collection identifier
 * @property {string} name - Display name for the collection
 * @property {string} description - Collection description
 */

/**
 * The application state, which is often passed to the plugin endpoints
 *
 * @typedef {object} ApplicationState
 * @property {string|null} sessionId - The session id of the particular app instance in a browser tab/window
 * @property {string|null} pdf - The document identifier for the PDF file in the viewer
 * @property {string|null} xml - The document identifier for the XML file in the editor
 * @property {string|null} diff - The document identifier for an XML file which is used to create a diff, if any
 * @property {string|null} xpath - The current xpath used to select a node in the editor
 * @property {string|null} variant - The variant filter to show only files with matching variant-id
 * @property {boolean} webdavEnabled - Wether we have a WebDAV backend on the server
 * @property {boolean} editorReadOnly - Whether the XML editor is read-only
 * @property {boolean} offline  - Whether the application is in offline mode, i.e. the backend has disconnected
 * @property {UserData|null} user - The currently logged-in user
 * @property {string|null} collection - The collection the current document is in
 * @property {FileListItem[]|null} fileData - The file data loaded from the server
 * @property {CollectionInfo[]|null} collections - The list of accessible collections
 * @property {boolean} hasInternet - Whether the backend has internet access
 * @property {Record<string, any>} ext - Extension object for plugins to store additional state properties
 * @property {ApplicationState|null} previousState - Links to the previous state object
 */

/**
 * The initial application state
 * @type{ApplicationState}
 */
const initialState = {
  pdf: null,
  xml: null,
  diff: null,
  xpath: null,
  variant: null,
  webdavEnabled: false,
  editorReadOnly: false,
  sessionId: null,
  user: null,
  collection: null,
  fileData: null,
  collections: null,
  offline: false,
  hasInternet: false,
  ext: {},
  previousState: null
}

export default initialState
export { initialState }
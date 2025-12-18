/**
 * @file Manifest file for all TEI Wizard enhancements.
 * To add a new enhancement:
 * 1. Create a new file in the 'enhancements' directory with the enhancement logic.
 * 2. Import it here.
 * 3. Add it to the 'enhancements' array.
 *
 * Enhancement execute() function signature:
 * The execute function receives three parameters:
 * - teiDoc: The TEI XML DOM Document object to be modified
 * - currentState: The current application state
 * - configMap: The application configuration as a Map
 * And returns the modified XML DOM Document object.
 */

/**
 * @import { ApplicationState } from '../../state.js'
 */

import prettyPrintXml from './enhancements/pretty-print-xml.js';
import removeBlankLines from './enhancements/remove-blank-lines.js';
import addRngSchemaDefinition from './enhancements/add-rng-schema-definition.js';

/**
 * Enhancement execute function signature
 * @typedef {function(Document, ApplicationState, Map<string, any>): Document} EnhancementExecuteFunction
 */

/**
 * @typedef {Object} Enhancement
 * @property {string} name - The name of the enhancement.
 * @property {string} description - A brief description of what the enhancement does.
 * @property {EnhancementExecuteFunction} execute - The function to execute the enhancement.
 */

/** @type {Enhancement[]} */
const enhancements = [
  addRngSchemaDefinition,
  prettyPrintXml,
//  removeBlankLines // doesn't work as expected, needs more testing
];

export default enhancements;

/**
 * @file Manifest file for all TEI Wizard enhancements.
 * To add a new enhancement:
 * 1. Create a new file in the 'enhancement' directory with the enhancement logic.
 * 2. Import it here.
 * 3. Add it to the 'enhancements' array.
 */

import prettyPrintXml from './enhancements/pretty-print-xml.js';

/**
 * @typedef {Object} Enhancement
 * @property {string} name - The name of the enhancement.
 * @property {string} description - A brief description of what the enhancement does.
 * @property {function(Document): Document} execute - The function to execute the enhancement.
 */

/** @type {Enhancement[]} */
const enhancements = [
  prettyPrintXml
];

export default enhancements;

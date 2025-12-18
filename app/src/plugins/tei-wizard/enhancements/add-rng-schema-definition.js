/**
 * @file Enhancement: Adds RNG schema definition processing instruction
 */

/**
 * @import { ApplicationState } from '../../../state.js'
 */

/**
 * Removes existing schema declarations and adds RNG schema processing instruction.
 * This removes:
 * - Any existing <?xml-model ?> processing instructions
 * - XSD schema attributes (xsi:schemaLocation, xsi:noNamespaceSchemaLocation)
 * - RNG schema shorthand attributes (_relaxng_schema)
 * Then adds a new <?xml-model ?> processing instruction with the RNG schema URL.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {ApplicationState} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function addRngSchemaDefinition(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  // Get schema base URL from config
  const schemaBaseUrl = configMap.get('schema.base-url');
  if (!schemaBaseUrl) {
    throw new Error('Configuration value "schema.base-url" is not defined');
  }

  // Get variant from state
  const variantId = currentState.variant;
  if (!variantId) {
    throw new Error('State variable "variant" is not defined');
  }

  // Build the schema URL
  const schemaUrl = `${schemaBaseUrl}/${variantId}.rng`;

  // Remove existing <?xml-model ?> processing instructions
  const processingInstructions = Array.from(xmlDoc.childNodes).filter(
    node => node.nodeType === Node.PROCESSING_INSTRUCTION_NODE && node.nodeName === 'xml-model'
  );
  for (const pi of processingInstructions) {
    xmlDoc.removeChild(pi);
  }

  // Remove XSD schema attributes from root element
  const root = xmlDoc.documentElement;
  if (root) {
    // Remove xsi:schemaLocation and xsi:noNamespaceSchemaLocation
    root.removeAttribute('xsi:schemaLocation');
    root.removeAttribute('xsi:noNamespaceSchemaLocation');
    // Remove _relaxng_schema shorthand
    root.removeAttribute('_relaxng_schema');
  }

  // Create new <?xml-model ?> processing instruction
  const piData = `href="${schemaUrl}" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"`;
  const newPI = xmlDoc.createProcessingInstruction('xml-model', piData);

  // Insert the new PI after the XML declaration (if present) or at the beginning
  const xmlDeclaration = Array.from(xmlDoc.childNodes).find(
    node => node.nodeType === Node.PROCESSING_INSTRUCTION_NODE && node.nodeName === 'xml'
  );

  if (xmlDeclaration) {
    // Insert after XML declaration
    xmlDoc.insertBefore(newPI, xmlDeclaration.nextSibling);
  } else {
    // Insert at the beginning
    xmlDoc.insertBefore(newPI, xmlDoc.firstChild);
  }

  return xmlDoc;
}

export default {
  name: "Add RNG Schema Definition",
  description: "Replaces any existing schema declarations with an RNG schema processing instruction using the configured schema base URL and current variant.",
  execute: addRngSchemaDefinition
};

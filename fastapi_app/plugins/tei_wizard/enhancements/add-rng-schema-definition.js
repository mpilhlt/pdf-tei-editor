/**
 * @file Enhancement: Adds RNG schema definition processing instruction
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Add RNG Schema Definition";

/**
 * Description shown in the UI
 */
export const description = "Replaces any existing schema declarations with an RNG schema processing instruction. Reads the schema URL from the document header (ref with .rng target), falling back to config + variant.";

/**
 * Removes existing schema declarations and adds RNG schema processing instruction.
 * This removes:
 * - Any existing <?xml-model ?> processing instructions
 * - XSD schema attributes (xsi:schemaLocation, xsi:noNamespaceSchemaLocation)
 * - RNG schema shorthand attributes (_relaxng_schema)
 * Then adds a new <?xml-model ?> processing instruction with the RNG schema URL.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  // Try to get schema URL from document header: //application[@type="extractor"]/ref[ends-with(@target,'.rng')]
  const TEI_NS = 'http://www.tei-c.org/ns/1.0';
  let schemaUrl = null;
  const applications = xmlDoc.getElementsByTagNameNS(TEI_NS, 'application');
  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    if (app.getAttribute('type') === 'extractor') {
      const refs = app.getElementsByTagNameNS(TEI_NS, 'ref');
      for (let j = 0; j < refs.length; j++) {
        const target = refs[j].getAttribute('target') || '';
        if (target.endsWith('.rng')) {
          schemaUrl = target;
          break;
        }
      }
      if (schemaUrl) break;
    }
  }

  // Fallback: build from config + variant (for older documents without .rng ref)
  if (!schemaUrl) {
    const schemaBaseUrl = configMap.get('schema.base-url');
    const variantId = currentState.variant;
    if (schemaBaseUrl && variantId) {
      schemaUrl = `${schemaBaseUrl}/${variantId}.rng`;
    }
  }

  if (!schemaUrl) {
    throw new Error('Could not determine schema URL from document header or configuration');
  }

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

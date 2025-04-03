import { escapeRegExp } from './utils.js';
import { remote_xmllint } from './client.js'

const teiNsRegExp = new RegExp(escapeRegExp('{http://www.tei-c.org/ns/1.0}'), 'g');


// const xsd_docs = [];
// const xsd_files = ['/schema/tei.xsd', '/schema/xml.xsd'];
// load XSD
// (async () => {
//   try {
//     for (let xsd_file of xsd_files) {
//       xsd_docs.push(await(await fetch(xsd_file)).text())
//     }
//     console.log("XSD files loaded.");
//   } catch( error ) {
//     console.error("Error loading XSD files:", error.message)
//   }
// })();

export async function lintSource(view) {
  // we don't do linting until xmllint and xsd files have been loaded
  //if (!window.xmllint || xsd_docs.length < xsd_files.length) return [];

  // get text from document and lint it
  const doc = view.state.doc;
  const xml = doc.toString();

  if (xml == "") {
    return;
  }

  // in-browser schema validation not yet working
  //const config = {xml, schema: xsd_docs};
  //const {errors} =  xmllint.validateXML(config)
  //const xmlLint_error_re = /^(.+?)_(\d)\.(xml|xsd):(\d+): (.+?) : (.+)/

  // use remote xmllint
  const xmlLint_error_re = /^(.*?)(xml|xsd):(\d+): (.+?) : (.+)/
  const { errors } = await remote_xmllint(xml);

  // convert xmllint errors to Diagnostic objects
  const diagnostics = errors.map(error => {
    //"file_0.xml:26: parser error : Extra content at the end of the document"
    let m = error.match(xmlLint_error_re)
    if (!m) {
      // ignore all messages that cannot be parsed
      return null;
    }
    //let [,, fileNumber, type, lineNumber, name, message] = m;
    let [, fileNumber, type, lineNumber, name, message] = m;
    fileNumber = parseInt(fileNumber) || null;
    lineNumber = parseInt(lineNumber);
    message = message.replaceAll(teiNsRegExp, 'tei:')
    let from, to;
    if (type === 'xml') {
      ({ from, to } = doc.line(lineNumber));
    } else {
      from = to = lineNumber;
    }
    const severity = "error"
    return { type, fileNumber, from, to, severity, name, message, lineNumber };
  }).filter(Boolean);

  // xsd errors are serious
  const xsd_errors = diagnostics.filter(d => d.type == 'xsd');
  if (xsd_errors.length > 0) {
    xsd_errors.forEach(d => {
      //console.error(`${xsd_files[d.fileNumber]}, line ${d.lineNumber}: (${d.name}) ${d.message}`);
      console.error(`XSD, line ${d.lineNumber}: (${d.name}) ${d.message}`);
    });
  }

  // xml errors are informational, dealt by linter
  const xml_errors = diagnostics.filter(d => d.type == 'xml');
  if (xml_errors.length > 0) {
    console.log(`${xml_errors.length} linter error(s) found.`)
    //xml_errors.forEach(d => {
    //  console.log(`Line ${d.lineNumber}: ${d.message}`);
    //});
  }
  return xml_errors;
}
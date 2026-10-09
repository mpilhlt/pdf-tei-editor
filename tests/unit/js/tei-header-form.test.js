#!/usr/bin/env node

/**
 * @testCovers app/src/modules/tei-header-form.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { FIELD_DEFS, readFieldValues, applyFieldValues } from '../../../app/src/modules/tei-header-form.js';

const NS = 'http://www.tei-c.org/ns/1.0';

/**
 * @param {string} fileDescInnerXml
 * @returns {Element} the parsed <fileDesc> element
 */
function parseFileDesc(fileDescInnerXml) {
  const dom = new JSDOM(
    `<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc>${fileDescInnerXml}</fileDesc></teiHeader></TEI>`,
    { contentType: 'text/xml' }
  );
  return dom.window.document.getElementsByTagName('fileDesc')[0];
}

const FULL_FIXTURE = `
  <titleStmt><title>Existing Title</title></titleStmt>
  <publicationStmt>
    <publisher>Nomos Verlag</publisher>
    <date type="publication">2020</date>
    <idno type="DOI">10.1/existing</idno>
  </publicationStmt>
  <sourceDesc>
    <bibl>Existing citation text.</bibl>
    <biblStruct>
      <analytic>
        <title>Article Title</title>
        <author><persName>First Author</persName></author>
        <author><persName>Second Author</persName></author>
      </analytic>
      <monogr>
        <title>Journal Title</title>
      </monogr>
    </biblStruct>
  </sourceDesc>
`;

describe('readFieldValues', () => {
  it('reads every field at its fixed path from a fully-populated fileDesc', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const values = readFieldValues(fileDesc);
    assert.strictEqual(values.title[0].text, 'Existing Title');
    assert.strictEqual(values.publisher[0].text, 'Nomos Verlag');
    assert.strictEqual(values.pubDate[0].text, '2020');
    assert.strictEqual(values.doi[0].text, '10.1/existing');
    assert.strictEqual(values.bibl[0].text, 'Existing citation text.');
    assert.strictEqual(values.analyticTitle[0].text, 'Article Title');
    assert.strictEqual(values.monogrTitle[0].text, 'Journal Title');
    assert.deepStrictEqual(values.author.map((v) => v.text), ['First Author', 'Second Author']);
  });

  it('returns empty arrays for every field when fileDesc is empty or null', () => {
    const fileDesc = parseFileDesc('');
    const values = readFieldValues(fileDesc);
    for (const def of FIELD_DEFS) assert.deepStrictEqual(values[def.key], []);
    const valuesFromNull = readFieldValues(null);
    for (const def of FIELD_DEFS) assert.deepStrictEqual(valuesFromNull[def.key], []);
  });

  it('matches idno[@type="DOI"] specifically, not an idno with a different type', () => {
    const fileDesc = parseFileDesc('<publicationStmt><idno type="ISSN">1234-5678</idno></publicationStmt>');
    const values = readFieldValues(fileDesc);
    assert.deepStrictEqual(values.doi, []);
  });

  it('reads an author with nested forename/surname markup as a readonly entry, whitespace collapsed', () => {
    const fileDesc = parseFileDesc(`
      <sourceDesc><biblStruct><analytic>
        <author><persName>
          <forename>Gianna</forename>
          <surname>Iacino</surname>
        </persName></author>
        <author><persName>Plain Author</persName></author>
      </analytic></biblStruct></sourceDesc>
    `);
    const values = readFieldValues(fileDesc);
    assert.strictEqual(values.author[0].text, 'Gianna Iacino');
    assert.strictEqual(values.author[0].readonly, true);
    assert.ok(values.author[0].element);
    assert.strictEqual(values.author[1].text, 'Plain Author');
    assert.strictEqual(values.author[1].readonly, undefined);
  });
});

describe('applyFieldValues', () => {
  it('REGRESSION: leaves every field byte-identical when nothing changed, including nested biblStruct markup', () => {
    // This is the exact failure mode the fixed-field-list rewrite exists to
    // prevent: the old generic tree flattened biblStruct/analytic's real
    // <title>/<author><persName> markup into plain concatenated text on
    // every save, even when the user touched nothing. Round-tripping
    // unmodified values must leave the whole subtree untouched.
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const before = fileDesc.cloneNode(true);
    const opened = readFieldValues(fileDesc);
    applyFieldValues(fileDesc, opened, opened, NS);
    assert.strictEqual(fileDesc.outerHTML, before.outerHTML, 'fileDesc must be byte-identical when no field changed');
  });

  it('updates an existing leaf in place without touching its siblings or position', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.publisher = [{ text: 'New Publisher' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const pubStmt = fileDesc.getElementsByTagName('publicationStmt')[0];
    assert.strictEqual(pubStmt.getElementsByTagName('publisher')[0].textContent, 'New Publisher');
    // Siblings and their order survive untouched.
    assert.strictEqual(pubStmt.children[1].localName, 'date');
    assert.strictEqual(pubStmt.children[1].textContent, '2020');
    assert.strictEqual(pubStmt.children[2].localName, 'idno');
  });

  it('creates a missing field (and its missing ancestors) only when a new, non-empty value is given', () => {
    const fileDesc = parseFileDesc('<titleStmt><title>T</title></titleStmt>');
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.monogrTitle = [{ text: 'New Journal' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const sourceDesc = fileDesc.getElementsByTagName('sourceDesc')[0];
    assert.ok(sourceDesc, 'sourceDesc must be created');
    const biblStruct = sourceDesc.getElementsByTagName('biblStruct')[0];
    assert.ok(biblStruct, 'biblStruct must be created');
    const monogr = biblStruct.getElementsByTagName('monogr')[0];
    assert.strictEqual(monogr.getElementsByTagName('title')[0].textContent, 'New Journal');
    // Unrelated fields (title) survive untouched.
    assert.strictEqual(fileDesc.getElementsByTagName('titleStmt')[0].getElementsByTagName('title')[0].textContent, 'T');
  });

  it('creates a missing root section (publicationStmt) before an already-existing later root (sourceDesc), per TEI ordering', () => {
    const fileDesc = parseFileDesc('<titleStmt><title>T</title></titleStmt><sourceDesc><bibl>B</bibl></sourceDesc>');
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.publisher = [{ text: 'New Publisher' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const tags = [...fileDesc.children].map((el) => el.localName);
    assert.deepStrictEqual(tags, ['titleStmt', 'publicationStmt', 'sourceDesc']);
  });

  it('removes a field whose value was cleared, and only that element', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.doi = [{ text: '' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const pubStmt = fileDesc.getElementsByTagName('publicationStmt')[0];
    assert.strictEqual(pubStmt.getElementsByTagName('idno').length, 0);
    assert.strictEqual(pubStmt.getElementsByTagName('publisher')[0].textContent, 'Nomos Verlag');
    assert.strictEqual(pubStmt.getElementsByTagName('date')[0].textContent, '2020');
  });

  it('handles adding a second author to a document that currently has only one', () => {
    const fileDesc = parseFileDesc('<sourceDesc><biblStruct><analytic><author><persName>Only Author</persName></author></analytic></biblStruct></sourceDesc>');
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.author = [{ text: 'Only Author' }, { text: 'New Second Author' }];
    applyFieldValues(fileDesc, opened, current, NS);
    const authors = fileDesc.getElementsByTagName('analytic')[0].getElementsByTagName('author');
    assert.strictEqual(authors.length, 2);
    assert.strictEqual(authors[0].getElementsByTagName('persName')[0].textContent, 'Only Author');
    assert.strictEqual(authors[1].getElementsByTagName('persName')[0].textContent, 'New Second Author');
  });

  it('handles removing one of two existing authors', () => {
    const fileDesc = parseFileDesc(FULL_FIXTURE);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.author = [{ text: 'First Author' }]; // second author row removed in the UI
    applyFieldValues(fileDesc, opened, current, NS);
    const authors = fileDesc.getElementsByTagName('analytic')[0].getElementsByTagName('author');
    assert.strictEqual(authors.length, 1);
    assert.strictEqual(authors[0].getElementsByTagName('persName')[0].textContent, 'First Author');
  });

  it('never rewrites a readonly author (nested forename/surname), even when another author in the same list changes', () => {
    const fileDesc = parseFileDesc(`
      <sourceDesc><biblStruct><analytic>
        <author><persName><forename>Gianna</forename><surname>Iacino</surname></persName></author>
        <author><persName>Plain Author</persName></author>
      </analytic></biblStruct></sourceDesc>
    `);
    const before = fileDesc.cloneNode(true);
    const opened = readFieldValues(fileDesc);
    const current = readFieldValues(fileDesc);
    current.author[1] = { text: 'Edited Plain Author' };
    applyFieldValues(fileDesc, opened, current, NS);
    const authors = fileDesc.getElementsByTagName('analytic')[0].getElementsByTagName('author');
    assert.strictEqual(authors.length, 2);
    // The structured author's markup must survive byte-identical.
    assert.strictEqual(authors[0].outerHTML, before.getElementsByTagName('analytic')[0].getElementsByTagName('author')[0].outerHTML);
    assert.strictEqual(authors[1].getElementsByTagName('persName')[0].textContent, 'Edited Plain Author');
  });

  it('removes a readonly author (whole repeat unit) when its row is deleted, leaving the other author untouched', () => {
    const fileDesc = parseFileDesc(`
      <sourceDesc><biblStruct><analytic>
        <author><persName><forename>Gianna</forename><surname>Iacino</surname></persName></author>
        <author><persName>Plain Author</persName></author>
      </analytic></biblStruct></sourceDesc>
    `);
    const opened = readFieldValues(fileDesc);
    const current = { ...opened, author: [opened.author[1]] }; // readonly row removed in the UI
    applyFieldValues(fileDesc, opened, current, NS);
    const authors = fileDesc.getElementsByTagName('analytic')[0].getElementsByTagName('author');
    assert.strictEqual(authors.length, 1);
    assert.strictEqual(authors[0].getElementsByTagName('persName')[0].textContent, 'Plain Author');
  });
});

#!/usr/bin/env node

/**
 * Unit tests for the people of a document: reading the respStmt persons with their revision and
 * comment counts, the responsibilities a user can be given, and adding a person.
 * @testCovers app/src/modules/document-people.js
 */

/**
 * @import { PersonRole } from '../../../app/src/modules/document-people.js'
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import {
  readPeople, rolesForUser, canAddPeople, addPersonRole, PERSON_ROLES
} from '../../../app/src/modules/document-people.js';

const DOC = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
        <respStmt>
          <persName xml:id="jdoe">Jane Doe</persName>
          <resp>Annotator</resp>
        </respStmt>
        <respStmt>
          <persName xml:id="asmith">Alex Smith</persName>
          <resp>Reviewer</resp>
          <resp>Commenter</resp>
        </respStmt>
        <respStmt>
          <persName xml:id="jdoe">Jane Doe</persName>
          <resp>Commenter</resp>
        </respStmt>
        <respStmt>
          <name>GROBID</name>
          <resp>Extraction</resp>
        </respStmt>
      </titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-10-01" who="#jdoe" status="draft"/>
      <change when="2026-10-02" who="#jdoe #asmith" status="draft"/>
      <change when="2026-10-03" who="#asmith" status="approved"/>
    </revisionDesc>
  </teiHeader>
  <standOff>
    <listAnnotation type="unit-comment" subtype="fp-sha256-8-v1">
      <annotation xml:id="uc-aaa111" motivation="commenting" target="#xpath(/TEI/text/body)" resp="#asmith">
        <revisionDesc><change when="2026-10-04T00:00:00Z" who="#asmith"/></revisionDesc>
        <note type="comment">Check this</note>
      </annotation>
      <annotation xml:id="uc-aaa112" motivation="replying" target="#uc-aaa111" resp="#jdoe">
        <revisionDesc><change when="2026-10-04T01:00:00Z" who="#jdoe"/></revisionDesc>
        <note type="comment">Done</note>
      </annotation>
      <annotation xml:id="uc-aaa113" motivation="replying" target="#uc-aaa111" resp="#asmith">
        <revisionDesc><change when="2026-10-04T02:00:00Z" who="#asmith"/></revisionDesc>
        <note type="comment">Thanks</note>
      </annotation>
    </listAnnotation>
  </standOff>
  <text><body/></text>
</TEI>`;

/**
 * @param {string} [xml]
 * @returns {Document}
 */
function parse(xml = DOC) {
  return new JSDOM(xml, { contentType: 'application/xml' }).window.document;
}

/**
 * @param {string} id
 * @returns {PersonRole}
 */
function role(id) {
  const found = PERSON_ROLES.find(r => r.id === id);
  if (!found) throw new Error(`no role ${id}`);
  return found;
}

describe('readPeople', () => {
  it('lists the respStmt persons with merged responsibilities and counts', () => {
    const people = readPeople(parse());
    assert.deepStrictEqual(people, [
      { id: 'jdoe', name: 'Jane Doe', responsibilities: ['Annotator', 'Commenter'], edits: 2, comments: 1 },
      { id: 'asmith', name: 'Alex Smith', responsibilities: ['Reviewer', 'Commenter'], edits: 2, comments: 2 },
      { id: null, name: 'GROBID', responsibilities: ['Extraction'], edits: 0, comments: 0 }
    ]);
  });

  it('returns an empty list without titleStmt', () => {
    assert.deepStrictEqual(readPeople(parse('<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>')), []);
  });
});

describe('rolesForUser and canAddPeople', () => {
  it('offers the responsibilities matching the user roles, commenting always', () => {
    const ids = (/** @type {string[]} */ roles) => rolesForUser({ username: 'u', fullname: '', roles }).map(r => r.id);
    assert.deepStrictEqual(ids(['user']), ['commenter']);
    assert.deepStrictEqual(ids(['user', 'annotator']), ['annotator', 'commenter']);
    assert.deepStrictEqual(ids(['user', 'reviewer']), ['reviewer', 'commenter']);
    assert.deepStrictEqual(ids(['*']), ['annotator', 'reviewer', 'commenter']);
    assert.deepStrictEqual(rolesForUser(null), []);
  });

  it('lets reviewers and admins add people', () => {
    assert.strictEqual(canAddPeople({ username: 'a', fullname: '', roles: ['user', 'reviewer'] }), true);
    assert.strictEqual(canAddPeople({ username: 'a', fullname: '', roles: ['admin'] }), true);
    assert.strictEqual(canAddPeople({ username: 'a', fullname: '', roles: ['user', 'annotator'] }), false);
    assert.strictEqual(canAddPeople(null), false);
  });
});

describe('addPersonRole', () => {
  it('adds a respStmt for a new person', () => {
    const doc = parse();
    assert.strictEqual(addPersonRole(doc, { username: 'bkim', fullname: 'Bo Kim' }, role('reviewer')), true);
    const person = readPeople(doc).find(p => p.id === 'bkim');
    assert.deepStrictEqual(person, { id: 'bkim', name: 'Bo Kim', responsibilities: ['Reviewer'], edits: 0, comments: 0 });
    const respStmt = doc.getElementsByTagName('respStmt')[4];
    assert.strictEqual(respStmt.namespaceURI, 'http://www.tei-c.org/ns/1.0');
    assert.strictEqual(respStmt.parentElement?.localName, 'titleStmt');
  });

  it('adds a resp to an existing person, once', () => {
    const doc = parse();
    assert.strictEqual(addPersonRole(doc, { username: 'asmith' }, role('annotator')), true);
    assert.deepStrictEqual(readPeople(doc).find(p => p.id === 'asmith')?.responsibilities, ['Reviewer', 'Commenter', 'Annotator']);
    assert.strictEqual(addPersonRole(doc, { username: 'asmith' }, role('reviewer')), false);
    assert.strictEqual(doc.getElementsByTagName('respStmt').length, 4);
  });

  it('uses the user name if there is no full name', () => {
    const doc = parse();
    addPersonRole(doc, { username: 'nofull' }, role('commenter'));
    assert.strictEqual(readPeople(doc).find(p => p.id === 'nofull')?.name, 'nofull');
  });
});

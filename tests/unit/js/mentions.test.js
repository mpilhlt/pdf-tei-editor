#!/usr/bin/env node

/**
 * Unit tests for the mention token rule and the mention candidates.
 * @testCovers app/src/modules/mentions.js
 * @testCovers app/src/modules/mention-autocomplete.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { findMentions, splitMentions, mentionQueryAt } from '../../../app/src/modules/mentions.js';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;
const { mentionCandidates } = await import('../../../app/src/modules/mention-autocomplete.js');

describe('mentions', () => {
  it('finds known mentions only', () => {
    assert.deepStrictEqual(findMentions('@jdoe and @asmith, mail a@b.org', new Set(['jdoe'])), ['jdoe']);
  });

  it('splits a text into plain parts and mentions', () => {
    assert.deepStrictEqual(splitMentions('Hi @jdoe, see @other.', new Set(['jdoe'])), [
      { text: 'Hi ', id: null },
      { text: '@jdoe', id: 'jdoe' },
      { text: ', see @other.', id: null }
    ]);
  });

  it('finds the partial token before the cursor', () => {
    assert.deepStrictEqual(mentionQueryAt('Ask @jd', 7), { from: 4, query: 'jd' });
    assert.deepStrictEqual(mentionQueryAt('Ask @', 5), { from: 4, query: '' });
    assert.strictEqual(mentionQueryAt('mail a@b', 8), null);
    assert.strictEqual(mentionQueryAt('Ask @jdoe now', 13), null);
  });

  it('offers the respStmt persons and the owner', () => {
    const xml = new dom.window.DOMParser().parseFromString(`<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt>
      <respStmt><persName xml:id="jdoe">Jane Doe</persName><resp>Annotator</resp></respStmt>
      <author><persName xml:id="not-a-resp">Author</persName></author>
    </titleStmt></fileDesc></teiHeader></TEI>`, 'application/xml');
    assert.deepStrictEqual(mentionCandidates(xml, 'owner'), [{ id: 'jdoe', name: 'Jane Doe' }, { id: 'owner', name: 'owner' }]);
    assert.deepStrictEqual(mentionCandidates(null, null), []);
  });
});

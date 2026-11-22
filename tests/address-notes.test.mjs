// "주소 메모", as the Android AddressNotesTest. Invented names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AddressNotes, noteKey} from '../dist/address-notes.mjs';

test('notes: found by the address with or without its region', () => {
  const notes = new AddressNotes();
  assert.equal(notes.put('어쩌리 166', '어쩌로 60-1 앞 밭'), true);
  assert.equal(notes.find('어쩌리 166'), '어쩌로 60-1 앞 밭');
  assert.equal(notes.find('가상도 솔내군 어쩌면 어쩌리 166'), '어쩌로 60-1 앞 밭');
  assert.equal(notes.find('어쩌리166'), '어쩌로 60-1 앞 밭');
  assert.equal(notes.find('어쩌리 167'), null);
  assert.equal(notes.find('어쩌리 166-1'), null);
  assert.equal(notes.find('어쩌리 산 166'), null);
  assert.equal(notes.find('어쩌리 166', null, '우정로 12'), '어쩌로 60-1 앞 밭');
  assert.equal(notes.find('', null), null);
});

test('notes: only an address with its number, an empty note removes it, the same keys as Android', () => {
  const notes = new AddressNotes();
  assert.equal(notes.put('어쩌리', '밭'), false);
  notes.put('어쩌리 166', '  밭  ');
  assert.equal(notes.find('어쩌리 166'), '밭');
  notes.put('어쩌리 166', ' ');
  assert.equal(notes.size, 0);
  assert.equal(noteKey('어쩌리 산 166'), 'PARCEL|어쩌리|산166');
  assert.equal(noteKey('우정로 12'), 'ROAD|우정로|12');
});

test('notes: kept as text and read back', () => {
  const notes = new AddressNotes();
  notes.put('어쩌리 166', '어쩌로 60-1 앞 밭\n개 조심');
  const back = new AddressNotes(notes.serialize());
  assert.equal(back.find('어쩌리 166'), '어쩌로 60-1 앞 밭\n개 조심');
  assert.equal(new AddressNotes('깨진 글').size, 0);
});

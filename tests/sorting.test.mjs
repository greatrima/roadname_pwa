import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLabel, describe, locate, overlaps, piece, summary, exportText, importText, PRIORITY, parseRackLabel, describeApartment, apartmentCells, assignApartment} from '../dist/sorting.mjs';

// Invented names only.
const rack = (labels, extra = {}) => ({name: '내 구역', columns: 6, rows: 6, labels: Object.fromEntries(labels), priority: PRIORITY.ROAD, outside: null, ...extra});
const road = (r, a, source = '') => locate(r, `울산광역시 복판구 ${a}`, null, source);
const parcel = (r, a, source = '') => locate(r, null, `울산광역시 복판구 ${a}`, source);
const read = text => { const l = parseLabel(text); return [...l.entries.map(describe), ...l.problems.map(p => `?${p}`)]; };

test('sorting: ranges keep the side of the street their ends name (as on Android)', () => {
  const r = rack([[1, '우정1길 1~19'], [2, '우정1길 2~20, 우정길 88']]);
  assert.deepEqual(road(r, '우정1길 15'), {cell: 1, outside: false});
  assert.deepEqual(road(r, '우정1길 8'), {cell: 2, outside: false});
  assert.deepEqual(road(r, '우정길 88'), {cell: 2, outside: false});
  assert.deepEqual(road(r, '우정1길 13-1'), {cell: 1, outside: false});
  assert.deepEqual(road(r, '우정1길 35'), {state: 'notMine'});
  assert.deepEqual(road(r, '누정로 5'), {state: 'notMine'});
  assert.deepEqual(road(rack([[3, '우편2길 28~2']]), '우편2길 5'), {state: 'unassigned'});
});

test('sorting: one way of writing, read alike however it is typed', () => {
  assert.deepEqual(read('우정동 127'), ['우정동 127']);
  assert.deepEqual(read('우정동127'), ['우정동 127']);
  assert.deepEqual(read('우정동 127번지'), ['우정동 127']);
  assert.deepEqual(read('우정12번길 5'), ['우정12번길 5']);
  assert.deepEqual(read('우정1길 1∼19'), ['우정1길 1~19 홀수']);
  assert.deepEqual(read('우편2길 28-2'), ['우편2길 28-2']);
  assert.deepEqual(read('우편 3길 28~2, 31'), ['우편3길 2~28 짝수', '우편3길 31']);
  assert.deepEqual(read('우정동 127-1~127-13'), ['우정동 127-1~127-13']);
  assert.deepEqual(read('우정동 127-1~13'), ['우정동 127-1~127-13']);
  assert.deepEqual(read('우정동 127번지 우편1길 1~29 우편2길 28'), ['우정동 127', '우편1길 1~29 홀수', '우편2길 28']);
  assert.deepEqual(read('우정길 9=11'), ['?우정길 9=11']);
  assert.deepEqual(read('가람2길 28~다솔로 16'), ['?가람2길 28~다솔로 16']);
});

test('sorting: narrower cells win, units, priority and outside cell', () => {
  const r = rack([[6, '누정동 127번지'], [7, '누정동'], [8, '221-1 한빛아파트 104동']]);
  assert.deepEqual(parcel(r, '누정동 127'), {cell: 6, outside: false});
  assert.deepEqual(parcel(r, '누정동 300'), {cell: 7, outside: false});
  assert.deepEqual(parcel(r, '누정동 221-1', '한빛아파트 104동 1203호'), {cell: 8, outside: false});
  const labels = [[1, '누정4길 50'], [2, '누정동 12-3']];
  const both = r2 => locate(r2, '울산광역시 복판구 누정4길 50', '울산광역시 복판구 누정동 12-3');
  assert.equal(both(rack(labels)).cell, 1);
  assert.equal(both(rack(labels, {priority: PRIORITY.PARCEL})).cell, 2);
  assert.deepEqual(road(rack([[1, '우정1길 1~19']], {outside: 36}), '누정로 5'), {cell: 36, outside: true});
  assert.deepEqual(road({columns: 0, rows: 0, labels: {}}, '우정1길 1'), {state: 'notConfigured'});
  assert.deepEqual(road(rack([]), '우정1길 1'), {state: 'unassigned'});
  assert.deepEqual(road(rack([[1, '우정1길 1~29'], [2, '우정1길 27']]), '우정1길 27'), {cell: 2, outside: false});
});

test('sorting: only an equally narrow address in another cell is an overlap', () => {
  const r = rack([[1, '우정1길 1~29']]);
  assert.deepEqual(overlaps(r, 2, '우정1길 27'), []);
  assert.deepEqual(overlaps(r, 2, '우정1길 1~29'), [1]);
  assert.deepEqual(overlaps(rack([[1, '우정1길 1~19'], [2, '우정1길 2~20']]), 3, '우정1길 20~2'), [2]);
  assert.deepEqual(overlaps(rack([[1, '우정1길 1~19']]), 3, '우정1길 2~20'), [], 'odd and even sides');
  assert.equal(summary(rack([[1, '우정1길 1~19'], [2, '']])), '6×6 · 1칸');
  assert.equal(piece('울산광역시 복판구 누정동 12-3'), '누정동 12-3');
  assert.equal(piece('울산광역시 복판구 누정4길 50 (누정동)'), '누정4길 50');
});

test('sorting: exported text comes back the same, in the app and the web alike', () => {
  const r = rack([[1, '우정1길 1~19'], [9, '누정4길 2~60, 누정동 127-3']], {name: '3구 대신 근무', priority: PRIORITY.PARCEL, outside: 36});
  const text = exportText(r);
  assert.equal(text, '도로명변환기 구분대 · 3구 대신 근무 · 6×6\n주소 기준: 지번 우선\n구역 밖 칸: 36\n1: 우정1길 1~19\n9: 누정4길 2~60, 누정동 127-3');
  const back = importText(`메모\n${text}\n`);
  assert.deepEqual(back.problems, ['메모'].filter(() => false));
  assert.deepEqual(back.rack, {name: '3구 대신 근무', columns: 6, rows: 6, labels: {1: '우정1길 1~19', 9: '누정4길 2~60, 누정동 127-3'}, priority: PRIORITY.PARCEL, outside: 36, apartments: []});
  assert.equal(importText('아무 글'), null);
  assert.deepEqual(importText('도로명변환기 구분대 · 6x6\n1: 우정1길 1~19\n이상한 줄').problems, ['이상한 줄']);
});

test('sorting: 아파트 묶기 places a complex by its 동, whichever of its addresses is written (as in the app)', () => {
  const apartment = {name: '우정아파트', main: '우정7길 12', shops: '우정대로 45, 소포길 102'};
  const r = rack([[3, '우정아파트 101,102'], [4, '우정아파트 103동, 104, 우정1길 1~19'], [9, '우정아파트 상가'], [10, '우정길 1~29']], {apartments: [apartment]});
  assert.deepEqual(locate(r, '우편특별시 통상구 우정7길 12', null, '101동 1203호'), {cell: 3, outside: false, apartment: '우정아파트', unit: '101동'});
  assert.deepEqual(locate(r, '우편특별시 통상구 소포길 102', null, '소포길 102 104동 501호'), {cell: 4, outside: false, apartment: '우정아파트', unit: '104동'}, "a shop's address with a 동 is a resident's");
  assert.deepEqual(locate(r, '우편특별시 통상구 우정대로 45', null, '1층 새움약국'), {cell: 9, outside: false, apartment: '우정아파트', unit: null}, "without a 동 it is a shop's");
  assert.deepEqual(locate(r, '우편특별시 통상구 우정7길 12', null, '107동 101호'), {state: 'unassigned'});
  assert.deepEqual(locate(r, '우편특별시 통상구 우정1길 3', null), {cell: 4, outside: false});
  assert.deepEqual(locate(r, '우편특별시 통상구 우정길 3', null), {cell: 10, outside: false});
  const label = parseRackLabel('우정아파트 101,102, 우정1길 1~19', r);
  assert.deepEqual(label.apartments.map(describeApartment), ['우정아파트 101동·102동']);
  assert.deepEqual(label.problems, []);
  assert.deepEqual(parseRackLabel('우정1길 1~19', {apartments: [{name: '우정'}]}).apartments, [], 'a name inside a word is left alone');
  const back = importText(exportText({...r, name: '내 구역'}));
  assert.deepEqual(back.rack.apartments, [apartment]);
});

test('sorting: the apartment table writes the cells\' labels (as in the app)', () => {
  const labels = {3: '우정아파트 101,102, 우정1길 1~19', 9: '우정아파트 상가', 10: '우정길 1~29'};
  assert.deepEqual(apartmentCells(labels, '우정아파트'), [['101', 3], ['102', 3], ['상가', 9]]);
  const written = assignApartment(labels, '우정아파트', [['101', 3], ['103', 4], ['104동', 4], ['상가', 9], ['전체', 5]]);
  assert.deepEqual(written, {3: '우정1길 1~19, 우정아파트 101', 4: '우정아파트 103,104', 5: '우정아파트', 9: '우정아파트 상가', 10: '우정길 1~29'});
  assert.deepEqual(assignApartment(labels, '우정아파트', []), {3: '우정1길 1~19', 10: '우정길 1~29'});
});

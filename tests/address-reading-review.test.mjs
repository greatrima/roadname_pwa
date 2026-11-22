// Address reading found in review 2026-11-22 (1~10), as the Android AddressReadingReviewTest. Invented names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Kind, extract, exactMatch, CandidateTracker} from '../dist/address-core.mjs';
import {AddressDictionary, AddressCandidateEngine} from '../dist/address-dictionary.mjs';

test('reading 1: building names starting with 동·호·층 after the number', () => {
  assert.equal(extract('가람로 25 동아아파트 101동 1203호'), '가람로 25');
  assert.equal(extract('가람로 25 호반베르디움'), '가람로 25');
  assert.equal(extract('가람로 25 층층빌딩'), '가람로 25');
  assert.equal(extract('가람동 12-3 동원빌라'), '가람동 12-3');
  assert.equal(extract('가람로 25동'), null);
});

test('reading 2: spaced 가길·나길·번가길·안길', () => {
  assert.equal(extract('새별로 20가길 5'), '새별로20가길 5');
  assert.equal(extract('새별로 20 나길 5'), '새별로20나길 5');
  assert.equal(extract('새별로 12번가길 7'), '새별로12번가길 7');
  assert.equal(extract('새별로 3안길 9'), '새별로3안길 9');
});

test('reading 3: a word on the line above is not glued to a short road', () => {
  assert.equal(extract('홍가람\n가람로 25'), '가람로 25');
  assert.equal(extract('가람\n동로 25'), '가람동로 25');
});

test('reading 4: spaced 동 N가', () => {
  assert.equal(extract('별수동 1가 12'), '별수동1가 12');
  assert.equal(extract('별수동 1 가 12'), '별수동1가 12');
});

test('reading 5: a name ending in 시·군·구 before the address is no region', () => {
  const engine = new AddressCandidateEngine(AddressDictionary.fromObject({경기도: {'솔내시 푸록구': {localities: ['차오동'], roads: {가람로: ['차오동']}}}}));
  const region = {province: '경기도', district: '솔내시 푸록구'};
  for (const road of ['가람로', '누리로']) {
    const found = engine.candidates([`김민구 ${road} 25`], region).map(c => c.text);
    assert.ok(!found.some(t => t.includes('김민구')), found.join());
    assert.ok(found.some(t => t.endsWith(`${road} 25`)), found.join());
  }
});

test('reading 6: an address after a field name on the same line', () => {
  assert.equal(extract('성명: 홍가람 / 주소: 가람로 25'), '가람로 25');
  assert.equal(extract('받는분 홍가람 주소: 가람로 25'), '가람로 25');
  assert.equal(extract('이름 홍가람 주소 가람로 25'), '가람로 25');
});

test('reading 7: the old 번지 호 notation', () => {
  assert.equal(extract('가람동 12번지 3호'), '가람동 12-3');
  assert.equal(extract('가람동 12번지 15호'), '가람동 12-15');
  assert.equal(extract('가람동 12번지 301호'), '가람동 12');
});

test('reading 8: short city names match the full ones', () => {
  assert.equal(exactMatch('서울시 가람구 가람로 25', '서울특별시 가람구 가람로 25'), true);
  assert.equal(exactMatch('부산시 새동구 가람로 25', '부산광역시 새동구 가람로 25'), true);
  assert.equal(exactMatch('광주시 새동구 가람로 25', '광주광역시 새동구 가람로 25'), true);
  assert.equal(exactMatch('광주시 가람로 25', '경기도 광주시 가람로 25'), true);
  assert.equal(exactMatch('부산시 새동구 가람로 25', '대구광역시 새동구 가람로 25'), false);
});

test('reading 9: 리 names kept with their 면 are real names alone', () => {
  const dictionary = AddressDictionary.fromObject({강원특별자치도: {솔내군: {localities: ['어쩌면 어쩌리', '어쩌면'], roads: {}}}});
  assert.equal(dictionary.isExactAddressName('어쩌리'), true);
  assert.deepEqual(dictionary.match('어저리', Kind.PARCEL, {province: '강원특별자치도', district: '솔내군'}).map(m => m.name), ['어쩌리']);
});

test('reading 10: a misread seen once leaves; the next slip replaces the last though its frames differ', () => {
  const road = text => ({text, kind: Kind.ROAD, completeness: 'COMPLETE', confidence: 100, details: ''});
  const tracker = new CandidateTracker();
  tracker.update([road('가람로 25')], 0);
  assert.deepEqual(tracker.update([road('가람로 25'), road('가람로 26')], 100).map(c => c.text), ['가람로 25', '가람로 26']);
  for (let i = 0; i < 4; i++) tracker.update([road('가람로 25')], 200 + i * 100);
  assert.deepEqual(tracker.update([road('가람로 25')], 700).map(c => c.text), ['가람로 25']);

  const next = new CandidateTracker();
  next.update([road('가람로 25')], 0);
  next.update([road('누리로 7'), road('누리로 1')], 100);
  next.update([road('누리로 7')], 200);
  const shown = next.update([road('누리로 7'), {...road('누리동 7'), kind: Kind.PARCEL}], 300);
  assert.equal(shown[0].text, '누리로 7');
  assert.ok(!shown.some(c => c.text === '가람로 25'));
});

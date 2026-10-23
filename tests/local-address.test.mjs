import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocal, lookupLocal, buildingByName, correctCandidates, CORRECTED, MISSING} from '../dist/local-address.mjs';
import {candidate, Kind, classify} from '../dist/address-core.mjs';

// Invented names only, in the format scripts/local-data.py writes.
const district = [
  '# address-lens-local-v1', '# version=202609', '# district=울산광역시 복판구',
  'R\t누정4길', 'R\t다솔로',
  'L\t누정동', 'L\t강솔면 모전리',
  'B\t0\t50\t0\t12-3\t\t한빛아파트',
  'B\t1\t7\t1\t산45\t',
  'B\t1\t9-1\t0\t200\t0:201;0:202',
  'B\t0\t52\t0\t300\t',
  'B\t1\t11\t0\t300\t',
  'B\t0\t56\t0\t310\t',
].join('\n');

test('local data: road and parcel addresses of the district convert without the servers', () => {
  const data = parseLocal(district);
  assert.equal(data.version, '202609');
  assert.equal(data.district, '복판구');
  assert.deepEqual(lookupLocal(data, '누정4길 50'), {recognizedAddress: '울산광역시 복판구 누정4길 50', convertedAddress: '울산광역시 복판구 누정동 12-3', recognizedKind: 'ROAD', source: 'LOCAL', buildingName: '한빛아파트'});
  assert.equal(lookupLocal(data, '울산광역시 복판구 누정4길 50').convertedAddress, '울산광역시 복판구 누정동 12-3');
  assert.equal(lookupLocal(data, '누정동 12-3').convertedAddress, '울산광역시 복판구 누정4길 50');
  assert.equal(lookupLocal(data, '모전리 산 45').convertedAddress, '울산광역시 복판구 다솔로 7');
  assert.equal(lookupLocal(data, '다솔로 7').convertedAddress, '울산광역시 복판구 강솔면 모전리 산 45');
  assert.equal(lookupLocal(data, '누정동 201').convertedAddress, '울산광역시 복판구 다솔로 9-1', 'a related parcel');
});

test('local data: what the district cannot tell is left to the servers', () => {
  const data = parseLocal(district);
  assert.equal(lookupLocal(data, '누정4길 51'), null, 'not in the file');
  assert.equal(lookupLocal(data, '울산광역시 한솔구 누정4길 50'), null, 'another district named');
  assert.equal(lookupLocal(data, '누정동 300'), null, 'one parcel, two road addresses');
  assert.equal(lookupLocal(null, '누정4길 50'), null);
  assert.equal(parseLocal('something else'), null);
});

test('local data: building names come with the address and find it without a number', () => {
  const data = parseLocal(district);
  assert.equal(lookupLocal(data, '누정4길 50').buildingName, '한빛아파트');
  assert.equal(lookupLocal(data, '울산광역시 복판구 누정동 한빛아파트 104동 1203호').convertedAddress, '울산광역시 복판구 누정동 12-3');
  assert.equal(buildingByName(data, '한빛 아파트 104동').number, '50');
  assert.equal(lookupLocal(data, '울산광역시 한솔구 한빛아파트'), null, 'another district named');
  assert.equal(lookupLocal(data, '없는아파트 104동'), null);
});

test('local data: impossible numbers are never converted by themselves, near real ones offered (as in the app)', () => {
  const data = parseLocal(district);
  const check = text => correctCandidates([candidate(text, classify(text))], data);
  assert.deepEqual(check('누정4길 50').map(c => [c.text, !!c.manualOnly]), [['누정4길 50', false]]);
  const misread = check('누정4길 60');
  assert.deepEqual(misread.map(c => [c.text, c.manualOnly, c.reviewReason]), [['누정4길 60', true, MISSING], ['누정4길 50', true, CORRECTED]]);
  assert.deepEqual(check('누정4길 54').map(c => c.text), ['누정4길 54', '누정4길 50', '누정4길 52', '누정4길 56']);
  assert.equal(check('누정4길 5')[0].manualOnly, true);
  assert.deepEqual(check('누장4길 50').map(c => c.text), ['누장4길 50', '누정4길 50']);
  assert.deepEqual(check('울산광역시 한솔구 누정4길 5').map(c => c.text), ['울산광역시 한솔구 누정4길 5']);
  assert.equal(correctCandidates([candidate('누정4길 5', Kind.ROAD)], null)[0].text, '누정4길 5');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocal, lookupLocal, buildingByName, correctNames, rememberDistrict, autoDistrict, mergeLocal, localEntries} from '../dist/local-address.mjs';

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

test('local data: misread road and 동 names are put right by the region\'s names (as in the app)', () => {
  const data = parseLocal(district);
  for (const read of ['다슬로 7', '타슬로 7', '다솔르 7', '울산광역시 복판구 다슬로 7']) assert.equal(correctNames(data, read), read.replace(/[다타][솔슬][로르]/, '다솔로'), read);
  assert.equal(correctNames(data, '누장동 12-3'), '누정동 12-3');
  assert.equal(correctNames(data, '모잔리 산45'), '모전리 산45');
  assert.equal(correctNames(data, '누정4길 50'), '누정4길 50');
  assert.equal(correctNames(data, '다슬로 8'), '다슬로 8');
  assert.equal(correctNames(data, '가나라로 7'), '가나라로 7');
  assert.equal(correctNames(data, '한빛아파트 104동 1203호'), '한빛아파트 104동 1203호');
  assert.equal(correctNames(null, '다슬로 7'), '다슬로 7');
  const numbered = parseLocal(['# address-lens-local-v1', '# district=울산광역시 복판구', 'R\t누정40길', 'R\t누정43길', 'L\t누정동', 'B\t0\t9\t0\t1\t', 'B\t1\t9\t0\t2\t'].join('\n'));
  assert.equal(correctNames(numbered, '누장43길 9'), '누정43길 9', 'the number inside the name decides');
});

test('local data: without a chosen region, the district of the lately converted addresses is found', () => {
  const converted = (address, source = 'VWORLD') => ({recognizedAddress: address, convertedAddress: address, recognizedKind: 'ROAD', source});
  let recent = [];
  for (const a of ['울산광역시 복판구 누정4길 50', '울산광역시 복판구 누정4길 52']) recent = rememberDistrict(recent, converted(a));
  assert.equal(autoDistrict(recent), null, 'two are not enough');
  // A bulk sender's letters count once.
  for (let i = 0; i < 5; i++) recent = rememberDistrict(recent, converted('경기도 솔내시 새움구 다솔로 7'));
  assert.equal(recent.length, 3);
  recent = rememberDistrict(recent, converted('울산광역시 복판구 다솔로 11'));
  assert.deepEqual(autoDistrict(recent), {province: '울산광역시', district: '복판구'});
  assert.equal(rememberDistrict(recent, converted('울산광역시 복판구 다솔로 13', 'LOCAL')), recent, "the region's own data adds nothing");
  // Only the last 20 different addresses count: the round moved.
  for (let n = 1; n <= 20; n++) recent = rememberDistrict(recent, converted(`경기도 솔내시 새움구 다솔로 ${n}`));
  assert.deepEqual(autoDistrict(recent), {province: '경기도', district: '솔내시 새움구'});
  assert.equal(autoDistrict([{key: 'a', district: '가|나'}, {key: 'b', district: '가|나'}, {key: 'c', district: '가|나'}, {key: 'd', district: '다|라'}, {key: 'e', district: '다|라'}, {key: 'f', district: '다|라'}]), null, 'a tie');
});

test('local data: a whole city of several 구 is joined and keeps each 구 in its addresses (as in the app)', () => {
  const east = ['# address-lens-local-v1', '# version=202609', '# district=경기도 솔내시 동녘구', 'R\t새움로', 'L\t버들동', 'L\t눤곡동', 'B\t0\t5\t0\t10\t1:11'].join('\n');
  const west = ['# address-lens-local-v1', '# version=202609', '# district=경기도 솔내시 서녘구', 'R\t다솔로', 'L\t모래동', 'B\t0\t8\t0\t20\t'].join('\n');
  const data = parseLocal(mergeLocal([east, west]));
  assert.equal(data.district, '솔내시');
  assert.equal(lookupLocal(data, '새움로 5').convertedAddress, '경기도 솔내시 동녘구 버들동 10');
  assert.equal(lookupLocal(data, '솔내시 다솔로 8').convertedAddress, '경기도 솔내시 서녘구 모래동 20');
  assert.equal(lookupLocal(data, '눤곡동 11').convertedAddress, '경기도 솔내시 동녘구 새움로 5', 'a related parcel keeps its locality');
  assert.equal(lookupLocal(data, '누정시 다솔로 8'), null, "another 시 is someone else's");
  assert.equal(mergeLocal([east]), east);
});

test('local data: a city chosen without its 구 takes every 구, and 세종 is found', () => {
  const index = [
    {code: '1', province: '경기도', district: '솔내시 동녘구'}, {code: '2', province: '경기도', district: '솔내시 서녘구'},
    {code: '3', province: '경기도', district: '솔내군'}, {code: '4', province: '세종특별자치시', district: ''},
  ];
  const codes = region => localEntries(index, region).map(e => e.code);
  assert.deepEqual(codes({province: '경기도', district: '솔내시'}), ['1', '2']);
  assert.deepEqual(codes({province: '경기도', district: '솔내시 서녘구'}), ['2']);
  assert.deepEqual(codes({province: '경기도', district: '솔내군'}), ['3'], 'not a prefix of another name');
  assert.deepEqual(codes({province: '세종특별자치시', district: '세종특별자치시'}), ['4']);
  assert.deepEqual(codes({province: '강원특별자치도', district: '솔내시'}), []);
});

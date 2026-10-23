import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocal, lookupLocal} from '../dist/local-address.mjs';

// Invented names only, in the format scripts/local-data.py writes.
const district = [
  '# address-lens-local-v1', '# version=202609', '# district=울산광역시 복판구',
  'R\t누정4길', 'R\t다솔로',
  'L\t누정동', 'L\t강솔면 모전리',
  'B\t0\t50\t0\t12-3\t',
  'B\t1\t7\t1\t산45\t',
  'B\t1\t9-1\t0\t200\t0:201;0:202',
  'B\t0\t52\t0\t300\t',
  'B\t1\t11\t0\t300\t',
].join('\n');

test('local data: road and parcel addresses of the district convert without the servers', () => {
  const data = parseLocal(district);
  assert.equal(data.version, '202609');
  assert.equal(data.district, '복판구');
  assert.deepEqual(lookupLocal(data, '누정4길 50'), {recognizedAddress: '울산광역시 복판구 누정4길 50', convertedAddress: '울산광역시 복판구 누정동 12-3', recognizedKind: 'ROAD', source: 'LOCAL'});
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

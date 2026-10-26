import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleRecent, addRecent} from '../dist/recent-address.mjs';

const converted = address => ({recognizedAddress: address, convertedAddress: `${address} (도로명)`});

test('recent addresses: off until a count is typed, newest first, each once (as in the app)', () => {
  assert.deepEqual(addRecent([], converted('우정동 1'), 0, false), []);
  let list = [];
  for (let n = 1; n <= 4; n++) list = addRecent(list, converted(`우정동 ${n}`), 3, false, n);
  assert.deepEqual(list.map(e => e.recognized), ['우정동 4', '우정동 3', '우정동 2']);
  list = addRecent(list, converted('우정동 2'), 3, false, 5);
  assert.deepEqual(list.map(e => e.recognized), ['우정동 2', '우정동 4', '우정동 3'], 'used again, it moves up');
  assert.deepEqual(visibleRecent(list, 0, false), [], 'off shows none');
});

test('recent addresses: with midnight only today\'s stay', () => {
  const now = Date.now(), yesterday = now - 24 * 3600 * 1000;
  let list = addRecent([], converted('우정동 1'), 10, false, yesterday);
  list = addRecent(list, converted('우정동 2'), 10, false, now);
  assert.equal(visibleRecent(list, 10, false, now).length, 2);
  assert.deepEqual(visibleRecent(list, 10, true, now).map(e => e.recognized), ['우정동 2']);
});

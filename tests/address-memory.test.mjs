// Ported from the Android AddressMemoryTest. Invented names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AddressMemory, MAX_NAMES, numberedWords, jamo, distance} from '../dist/address-memory.mjs';
import {AddressDictionary} from '../dist/address-dictionary.mjs';

const real = new Set(['누정4길', '누정5길', '눤곡동', '달선로']);
const isReal = word => real.has(word);

test('misread word is replaced only before its number and the number stays as read', () => {
  const memory = new AddressMemory();
  memory.learn('누저4긱', '누정4길');
  const result = memory.apply('울산광역시 복판구 누저4긱 50\n받는 분 나미래');
  assert.equal(result.text, '울산광역시 복판구 누정4길 50\n받는 분 나미래');
  assert.deepEqual(result.applied, [{misread: '누저4긱', corrected: '누정4길'}]);
  assert.equal(memory.apply('누저4긱 12-3').text, '누정4길 12-3');
  assert.equal(memory.apply('누저4긱50').text, '누정4길50');
  // Without a number it could be a name or a shop: left alone, like a unit ("101동").
  assert.equal(memory.apply('누저4긱').text, '누저4긱');
  assert.equal(memory.apply('누저4긱 101동').text, '누저4긱 101동');
  assert.deepEqual(memory.apply('달선로 50').applied, []);
});

test('confirmed address teaches the word read before the same number', () => {
  const memory = new AddressMemory();
  const source = '울산광역시 복판구 누저4긱 50\n101동 1203호\n나미래 귀하';
  assert.deepEqual(numberedWords(source), ['누저4긱']);
  assert.equal(memory.learnFromSource(source, '누정4길', '50', isReal), '누저4긱');
  assert.equal(memory.correction('누저4긱'), '누정4길');
  // Another number, other digits in the name, a real name or an unrelated word teach nothing.
  assert.equal(new AddressMemory().learnFromSource('누저4긱 51', '누정4길', '50', isReal), null);
  assert.equal(new AddressMemory().learnFromSource('누저5긱 50', '누정4길', '50', isReal), null);
  assert.equal(new AddressMemory().learnFromSource('누정5길 50', '누정4길', '50', isReal), null);
  assert.equal(new AddressMemory().learnFromSource('가나다라 50', '누정4길', '50', isReal), null);
  assert.equal(new AddressMemory().learnFromSource('누정4길 50', '누정4길', '50', isReal), null);
  assert.equal(new AddressMemory().learnFromSource('눤곡둥 산 12-3', '눤곡동', '12-3', isReal), '눤곡둥');
});

test('correcting again replaces the old pair and a changed address forgets it', () => {
  const memory = new AddressMemory();
  memory.learn('누저4긱', '누정5길');
  memory.learn('누저4긱', '누정4길');
  assert.equal(memory.correction('누저4긱'), '누정4길');
  memory.forget('누저4긱');
  assert.equal(memory.correction('누저4긱'), null);
  // Filled in by the memory, then typed over with another road: the wrong correction goes.
  const wrong = new AddressMemory();
  wrong.learn('누저4긱', '누정4길');
  assert.equal(wrong.learnFromSource('울산광역시 복판구 누저4긱 50', '달선로', '50', isReal), null);
  assert.equal(wrong.correction('누저4긱'), null);
  // Confirming the remembered name itself keeps it.
  const right = new AddressMemory();
  right.learn('누저4긱', '누정4길');
  right.learnFromSource('누저4긱 50', '누정4길', '50', isReal);
  assert.equal(right.correction('누저4긱'), '누정4길');
});

test('used names are counted, only names are stored and the oldest make room', () => {
  const memory = new AddressMemory();
  for (let i = 0; i < 3; i++) memory.rememberName('누정4길');
  memory.rememberName('눤곡동');
  memory.learn('누저4긱', '누정4길');
  assert.equal(memory.weight('누정4길'), 3);
  assert.equal(memory.weight('달선로'), 0);
  const stored = memory.serialize();
  assert.deepEqual(new Set(stored.trim().split('\n')), new Set(['N\t누정4길\t3', 'N\t눤곡동\t1', 'P\t누저4긱\t누정4길']));
  const restored = new AddressMemory(stored);
  assert.equal(restored.weight('누정4길'), 3);
  assert.equal(restored.correction('누저4긱'), '누정4길');
  restored.clear();
  assert.ok(restored.isEmpty);
  assert.equal(restored.serialize(), '');
  // Broken storage is ignored.
  const broken = new AddressMemory('N\t누정4길\tmany\nX\ta\tb\nP\t누저4긱\nN\t눤곡동\t2\n\n');
  assert.equal(broken.weight('누정4길'), 0);
  assert.equal(broken.weight('눤곡동'), 2);
  const full = new AddressMemory();
  for (let i = 0; i < MAX_NAMES + 5; i++) full.rememberName(`가나${i}로`);
  assert.equal(full.weight('가나0로'), 0);
  assert.equal(full.weight(`가나${MAX_NAMES + 4}로`), 1);
  assert.equal(full.serialize().trim().split('\n').length, MAX_NAMES);
});

test('jamo distance and the dictionary name check', () => {
  assert.equal(distance(jamo('누저4긱'), jamo('누정4길')), 2);
  assert.equal(distance(jamo('가나다라'), jamo('누정4길'), 2), 3);
  const dictionary = AddressDictionary.fromObject({울산광역시: {'복판구': {localities: ['누정동'], roads: {누정4길: ['누정동']}}}});
  for (const name of ['누정4길', '누정동', '복판구', '울산광역시', '누정 4길']) assert.ok(dictionary.isExactAddressName(name), name);
  for (const name of ['누저4긱', '누정5길', '달선로']) assert.ok(!dictionary.isExactAddressName(name), name);
});

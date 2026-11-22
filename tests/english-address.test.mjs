// EMS addresses in English, read against an invented district (as Android EnglishAddressTest).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {romanize, romanizeWord, looksEnglish, englishAddress, englishPlaces, englishSourceText, bothForms, readInEnglish} from '../dist/address-core.mjs';

const places = englishPlaces(['우정공원로', '우정로', '우정대로', '우정로12번길', '집배동로', '집배동로228길', '우편안길', '우편1길', '올림픽로'], ['집배동', '통상동']);
const read = text => englishAddress(text, '통상구', places);
const korean = text => read(text)?.korean;

test('english: romanization follows the signs', () => {
  assert.equal(romanize('우정공원로'), 'ujeonggongwon-ro');
  assert.equal(romanize('집배동로228길'), 'jipbaedong-ro 228-gil');
  assert.equal(romanize('우정로12번길'), 'ujeong-ro 12beon-gil');
  assert.equal(romanize('종로'), 'jong-ro');
  assert.equal(romanizeWord('신라'), 'silla');
  assert.equal(romanizeWord('독립'), 'dongnip');
  assert.equal(romanize('집배동'), 'jipbae-dong');
});

test('english: a road is found whatever the spelling and order', () => {
  assert.equal(korean('1101HO 101DONG, 12 WOOJEONG PARK-RO, TONGSANG-GU 12345 KOREA'), '통상구 우정공원로 12 101동 1101호');
  assert.equal(korean('Ujeonggongwon-ro 12, Tongsang-gu, Republic of Korea'), '통상구 우정공원로 12');
  assert.equal(korean('Woojeong gonwon ro 12, Tongsang-gu'), '통상구 우정공원로 12');
  assert.equal(korean('WOOJEONGGONGWONRO12 KOREA'), '통상구 우정공원로 12');
  assert.equal(korean('Apt 101dong 1101ho, Ujeong-ro 5, Tongsang-gu'), '통상구 우정로 5 101동 1101호');
  assert.equal(korean('12, Woojeong-daero, Tongsang-gu, Korea'), '통상구 우정대로 12');
  assert.equal(korean('30 Ujeong Avenue, Tongsang-gu, Korea'), '통상구 우정대로 30');
  assert.equal(korean('Upyeon 1-gil 3, Tongsang-gu, Korea'), '통상구 우편1길 3');
  assert.equal(korean('OLYMPIC-RO 300 TONGSANG-GU KOREA'), '통상구 올림픽로 300');
});

test('english: numbered roads', () => {
  assert.equal(korean('Jipbaedong-ro 228-gil 7, Tongsang-gu, Korea'), '통상구 집배동로228길 7');
  assert.equal(korean('Jipbaedong-ro 228beon-gil 7, Korea'), '통상구 집배동로228길 7');
  assert.equal(korean('3, Ujeong-ro 12beon-gil, Tongsang-gu, Korea'), '통상구 우정로12번길 3');
});

test('english: units are written many ways', () => {
  for (const text of ['101dong 1101ho, Ujeong-ro 5, Korea', '1101ho 101dong, Ujeong-ro 5, Korea', 'Ujeong-ro 5, 101-dong 1101-ho, Korea',
    'Ujeong-ro 5, Apt 101-1101, Korea', 'Ujeong-ro 5, Bldg 101 #1101, Korea', 'Ujeong-ro 5, 101D 1101HO, KOREA']) {
    assert.equal(korean(text), '통상구 우정로 5 101동 1101호', text);
  }
  const bare = read('Ujeong-ro 5, 101-1101, Tongsang-gu');
  assert.equal(bare.korean, '통상구 우정로 5 101동 1101호');
  assert.equal(bare.unitUnsure, true);
  assert.equal(read('Ujeong-ro 5, 101dong 1101ho').unitUnsure, false);
  assert.equal(korean('Ujeong-ro 5 Unit 1203, Korea'), '통상구 우정로 5 1203호');
});

test('english: a parcel address is read by its place; name and phone are left out', () => {
  assert.equal(korean('817-96 Jipbae-dong, Tongsang-gu, Korea'), '통상구 집배동 817-96');
  assert.equal(korean('JIPBAE-DONG 817-96 TONGSANG-GU KOREA'), '통상구 집배동 817-96');
  const r = read('KIM MINSU\nTel +82-10-1234-5678\n12 Ujeong-ro\nTongsang-gu 12345\nKOREA');
  assert.equal(r.korean, '통상구 우정로 12');
  assert.ok(!r.english.includes('5678'));
});

test('english: Korean or unknown text is left to the usual reading', () => {
  assert.equal(looksEnglish('우정특별시 통상구 우정공원로 12'), false);
  assert.equal(korean('Hello world, nice to meet you'), undefined);
  assert.equal(korean('221B Baker Street, London'), undefined);
});

test('english: "동·호 확인" comes first, so a long line cut short never hides it', () => {
  assert.equal(englishSourceText({english: '12 Ujeong-ro, Tongsang-gu', unitUnsure: true}), '동·호 확인 · 12 Ujeong-ro, Tongsang-gu');
  assert.equal(englishSourceText({english: '12 Ujeong-ro', unitUnsure: false}), '12 Ujeong-ro');
});

test('english: a result read in English is shown in both forms, 도로명 then 지번', () => {
  assert.deepEqual(bothForms('통상구 우정로 12', '통상구 집배동 34'), [['도로명', '통상구 우정로 12'], ['지번', '통상구 집배동 34']]);
  assert.equal(readInEnglish('우정로12', '우정특별시 통상구 우정로 12'), true);
  assert.equal(readInEnglish('우정로12', '우정특별시 통상구 별골로 1'), false);
  assert.equal(readInEnglish('', '우정로 12'), false);
});

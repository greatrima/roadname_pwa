// Ported from the Android unit tests (AddressTextParserTest, AddressVerificationTest, RawSearchFlowTest, OcrStructureTest).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Kind, COMPLETE, candidate, extract, extractCandidate, extractCandidates, classify, restoreStructuredText, parseParts,
  exactMatch, relatedParcels, candidatesFromBlocks, candidatesFromSpatialBlocks, automaticCandidate, assembleLines,
  assembleElements, rowsFromBoxes, identity, stripAddressLabels,
} from '../dist/address-core.mjs';

const region = {province: '경기도', district: '솔내시 푸록구'};
const raw = (text, selected = region) => candidatesFromBlocks([text], selected);
const first = (text, selected = region) => raw(text, selected).find(c => c.completeness === COMPLETE);
const line = (text, x, y, w, h) => ({text, box: {left: x, top: y, right: x + w, bottom: y + h}});
const pipeline = (...lines) => candidatesFromSpatialBlocks(assembleLines(lines), {province: '경기도', district: '솔내시 새움구'});

test('parser: simple, noisy, multiline', () => {
  assert.equal(extract('버들동 716-7'), '버들동 716-7');
  assert.equal(extract('대한민국\n지번 주소: 경기도 솔내시 새움구 버들동 716－7\n우편번호'), '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(extract('버들동\n716-7'), '버들동 716-7');
  assert.equal(extract('뭉암동\n118-36'), '뭉암동 118-36');
  assert.equal(extract('물정동 1011\n-375'), '물정동 1011-375');
  assert.equal(extract('뫼천동 849\n-25'), '뫼천동 849-25');
});

test('parser: ambiguous, road, details', () => {
  assert.deepEqual(new Set(extractCandidates('뭉암동 118-36\n눤곡동 814').map(c => c.text)), new Set(['뭉암동 118-36', '눤곡동 814']));
  assert.equal(extract('안녕하세요 버들동입니다'), null);
  assert.equal(extract('새움구 늘촌1길 4-1'), '새움구 늘촌1길 4-1');
  assert.equal(extractCandidate('새움구 늘촌1길 4-1').kind, Kind.ROAD);
  assert.equal(classify('버들동 716-7'), Kind.PARCEL);
  assert.equal(extract('경기도 솔내시 새움구 늘촌1길 4-1 1층 2호 (버들동)'), '경기도 솔내시 새움구 늘촌1길 4-1');
  const ocr = '경기도 솔내시 새움구 가람\n동로 25(모잔동. 솔내호\n수타운 가온아파트) 102동 2\n901호';
  assert.equal(extract(ocr), '경기도 솔내시 새움구 가람동로 25');
  assert.equal(restoreStructuredText(ocr).replace(/\n/g, ' '), '경기도 솔내시 새움구 가람동로 25(모잔동. 솔내호수타운 가온아파트) 102동 2901호');
  assert.equal(extract('별골로12길 123-4, 101동 1203호'), '별골로12길 123-4');
  assert.equal(extract('차오동 산123 - 4번지 2층'), '차오동 산 123-4');
  for (const text of ['가람동로 25, 101동 1203호', '가람동로 25, 2층', '가람동로 25, 지하 1호']) assert.equal(extract(text), '가람동로 25');
  assert.equal(extract('뭉암동\n\n118-36'), null);
  assert.equal(extract('010-1234-5678\n12345\n홍길동'), null);
});

test('validator: exact gate without fuzzy numbers', () => {
  const cleaned = extract('서울 복판구\n한당동 5');
  assert.equal(cleaned, '서울특별시 복판구 한당동 5');
  assert.equal(exactMatch(cleaned, '부산광역시 복판구 한당동 5'), false);
  const query = '경기도 솔내시 푸록구 차오동 5';
  assert.equal(exactMatch(query, `${query} (차오빌라)`), true);
  for (const wrong of ['경기도 솔내시 푸록구 차오동 5-1', '경기도 솔내시 푸록구 차오동 산 5', '경기도 솔내시 푸록구 나동 5',
    '경기도 솔내시 새움구 차오동 5', '경기도 달뫼시 푸록구 차오동 5']) assert.equal(exactMatch(query, wrong), false, wrong);
  assert.equal(exactMatch('차오동 5-1', '차오동 5'), false);
  assert.equal(exactMatch('차오동 산 5-1', '차오동 5-1'), false);
  assert.equal(exactMatch('경기 솔내시 차오동 5-1', '경기도 솔내시 푸록구 차오동 5-1'), true);
  assert.equal(exactMatch('충남 뫼산군 삽다읍 새마리 5', '충청남도 뫼산군 들산면 새마리 5'), false);
  const related = relatedParcels('경기도 솔내시 푸록구 차오동 5-1', '5-1, 5-2');
  assert.ok(related.some(r => exactMatch('차오동 5-2', r)));
  assert.ok(!related.some(r => exactMatch('차오동 5', r)));
  assert.deepEqual(relatedParcels('차오동 5-1', '5-1 외 2필지'), []);
  assert.deepEqual(relatedParcels('차오동 산 5', '6'), []);
  assert.deepEqual(relatedParcels('차오동 산 5', '산 6'), ['차오동 산 6']);
  assert.equal(automaticCandidate([candidate('차오동 5-1', Kind.PARCEL, {manualOnly: true})]), null);
});

test('raw search flow: region supplement and search gate', () => {
  const typo = first('경기도 솔내시 푸콕구 별골로 123');
  assert.equal(typo.text, '경기도 솔내시 푸콕구 별골로 123');
  assert.equal(automaticCandidate([typo]), typo);
  const noisy = first('홍길동\n010-1234-5678\n12345\n경기도 솔내시 푸록구 별골로 123, 101동 1203호\n배송관리부');
  assert.equal(noisy.text, '경기도 솔내시 푸록구 별골로 123');
  assert.ok(noisy.details.includes('1203호'));
  assert.equal(first('차오동 123-4').text, '경기도 솔내시 푸록구 차오동 123-4');
  assert.equal(first('별골로 123').text, '경기도 솔내시 푸록구 별골로 123');
  assert.equal(first('푸록구 차오동 5').text, '경기도 솔내시 푸록구 차오동 5');
  assert.equal(first('차오동 5', {province: '경기도', district: ''}).text, '경기도 차오동 5');
  assert.equal(first('서울 복판구 한당동 5').text, '서울특별시 복판구 한당동 5');
  assert.equal(first('부산광역시 복판구 뭉운동 5').text, '부산광역시 복판구 뭉운동 5');
  assert.equal(first('달뫼시 별통구 뭉탄동 5').text, '달뫼시 별통구 뭉탄동 5');
  assert.equal(first('경기도 솔내시 새움구 버들동 5').text, '경기도 솔내시 새움구 버들동 5');
  const multi = first('경기도 솔내시 새움구 가람\n동로 25(모잔동. 솔내호\n수타운 가온아파트) 102동 2\n901호');
  assert.equal(multi.text, '경기도 솔내시 새움구 가람동로 25');
  assert.ok(multi.details.includes('2901호'));
  assert.equal(first('별골로12길123-4').text, '경기도 솔내시 푸록구 별골로12길 123-4');
  assert.equal(first('차오동 산5-1번지').text, '경기도 솔내시 푸록구 차오동 산 5-1');
  for (const text of ['차오동', '별골로', '차오동 010-1234-5678', '별골로 101동 1203호', '홍길동\n12345']) {
    assert.equal(automaticCandidate(raw(text)), null, text);
  }
  const two = candidatesFromBlocks(['차오동 5', '버들동 7'], {province: '', district: ''});
  assert.equal(two.length, 2);
  assert.equal(automaticCandidate(two), null);
  assert.ok(candidatesFromBlocks(['차오동', '123'], region).every(c => c.completeness !== COMPLETE));
});

test('ocr structure: hyphen, units and spatial joins', () => {
  const hyphenated = pipeline(line('뭉게물', 10, 0, 100, 15), line('경기도 솔내시 새움구 뫄동 695-', 10, 30, 500, 20), line('1 303', 10, 58, 100, 20));
  const selected = automaticCandidate(hyphenated);
  assert.equal(selected?.text, '경기도 솔내시 새움구 뫄동 695-1');
  assert.equal(selected.details, '');
  assert.ok(!hyphenated.some(c => c.text.endsWith('뫄동 695')));
  for (const text of ['뫄동 695-', '뫄동 695 -', '뫄동 695 - ', '별골로 123 -', '뫄동 산 5 -']) {
    assert.equal(extract(text), null, text);
    assert.equal(automaticCandidate(candidatesFromBlocks([text], {})), null, text);
  }
  const rows = [[line('뫄동', 10, 10, 70, 20), line('695', 85, 10, 50, 20), line('-', 140, 10, 10, 20)], [line('1', 10, 38, 15, 20), line('303', 30, 38, 55, 20)]];
  const spaced = candidatesFromSpatialBlocks(assembleElements(rows), {});
  assert.equal(automaticCandidate(spaced)?.text, '뫄동 695-1');
  assert.equal(spaced.length, 1);
  assert.equal(spaced[0].details, '');
  for (const next of [line('1 303', 600, 38, 100, 20), line('1 303', 10, 200, 100, 20), line('203호', 10, 38, 100, 20), line('010-1234-5678', 10, 38, 200, 20)]) {
    assert.equal(automaticCandidate(pipeline(line('뫄동 695 -', 10, 10, 200, 20), next)), null, next.text);
  }
  assert.equal(extract('뫄동 695-1 -'), null);
  assert.equal(extract('뫄동 695 - 1 303'), '뫄동 695-1');

  const parcelRoom = candidatesFromSpatialBlocks(assembleLines([line('경기 솔내시 새움구 버들동', 20, 20, 1000, 50), line('716-7 203호', 440, 90, 500, 50)]), {province: '경기도', district: ''});
  const pr = automaticCandidate(parcelRoom);
  assert.equal(pr?.text, '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(pr.details, '203호');
  const roadSplit = candidatesFromSpatialBlocks(assembleLines([line('경기 솔내시 새움구 달선1', 20, 20, 1000, 50), line('로 37 104동1202호', 20, 90, 700, 50)]), {province: '경기도', district: ''});
  const rs = automaticCandidate(roadSplit);
  assert.equal(rs?.text, '경기도 솔내시 새움구 달선1로 37');
  assert.equal(rs.details, '104동 1202호');
  const fonts = assembleLines([line('경기도 솔내시 새움구 가람', 10, 10, 220, 14), line('동로 25', 10, 30, 100, 28)]);
  assert.equal(fonts.length, 1);
  assert.equal(extract(fonts[0].text), '경기도 솔내시 새움구 가람동로 25');
});

test('ocr structure: indents, suffixes, noise and columns', () => {
  for (const [stem, number, expected] of [['별골로', '123, 101동 1203호', '별골로 123'], ['차오동', '산 5-1 2층', '차오동 산 5-1']]) {
    const candidates = pipeline(line(stem, 10, 10, 260, 12), line(number, 120, 40, 180, 32));
    assert.equal(automaticCandidate(candidates)?.text, `경기도 솔내시 새움구 ${expected}`);
    assert.ok(candidates[0].details);
  }
  for (const [left, right, base] of [['별골로12', '길 123-4 101동1203호', '별골로12길 123-4'], ['가람', '동로 25 203호', '가람동로 25'], ['뭉운', '대로 25 2층', '뭉운대로 25']]) {
    const parts = parseParts(automaticCandidate(pipeline(line(left, 10, 10, 240, 20), line(right, 10, 38, 240, 20))).text);
    assert.equal(`${parts.name} ${parts.number}`, base);
  }
  const hyphen = automaticCandidate(pipeline(line('버들동 716-', 10, 10, 220, 20), line('7 203호', 10, 38, 140, 20)));
  assert.ok(hyphen.text.endsWith('버들동 716-7'));
  assert.equal(hyphen.details, '203호');
  const noHyphen = pipeline(line('버들동 716', 10, 10, 220, 20), line('7 203호', 10, 38, 140, 20));
  assert.ok(noHyphen.every(c => !c.text.endsWith('7167') && !c.text.endsWith('716-7')));
  const firstRow = [line('경기 솔내시 새움구 버들동', 10, 10, 500, 30)];
  const separated = candidatesFromSpatialBlocks(assembleElements([firstRow, [line('716-7', 180, 55, 100, 30), line('203호', 290, 55, 90, 30)]]), {province: '경기도', district: ''});
  assert.equal(automaticCandidate(separated)?.text, '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(separated[0].details, '203호');
  const packed = candidatesFromSpatialBlocks(assembleElements([firstRow, [line('716-7203호', 180, 55, 200, 30)]]), {province: '경기도', district: ''});
  assert.equal(automaticCandidate(packed), null);
  for (const noise of ['203호', '101동', '2층', '010-1234-5678', '우편번호: 12345', '이름: 홍길동 123', '배송 메모: 123', '부서: 영업1부']) {
    assert.equal(automaticCandidate(pipeline(line('버들동', 10, 10, 240, 20), line(noise, 10, 38, 240, 20))), null, noise);
  }
  assert.ok(automaticCandidate(pipeline(line('버들동 12345', 10, 10, 240, 20))).text.endsWith('12345'));
  const postal = pipeline(line('버들동', 10, 10, 240, 20), line('12345', 10, 38, 100, 20));
  assert.equal(postal.length, 1);
  assert.ok(postal[0].text.endsWith('12345'));
  assert.ok(postal[0].manualOnly);
  assert.equal(automaticCandidate(postal), null);
  const trace = [];
  const ambiguous = candidatesFromSpatialBlocks(assembleLines([line('버들동', 10, 10, 120, 20), line('눤곡동', 170, 10, 120, 20), line('716-7 203호', 10, 40, 280, 20)], trace), {});
  assert.equal(automaticCandidate(ambiguous), null);
  assert.ok(trace.some(t => t.includes('가능한 앞줄이 여러 개')));
  assert.equal(automaticCandidate(pipeline(line('버들동', 10, 10, 120, 20), line('716-7 203호', 400, 40, 240, 20))), null);
});

test('ocr structure: same query for one or two lines, fields and hierarchy', () => {
  for (const [full, left, right] of [['경기 솔내시 새움구 버들동 716-7 203호', '경기 솔내시 새움구 버들동', '716-7 203호'],
    ['경기 솔내시 새움구 달선1로 37 104동1202호', '경기 솔내시 새움구 달선1', '로 37 104동1202호']]) {
    const single = pipeline(line(full, 10, 10, 800, 30));
    const wrapped = pipeline(line(left, 10, 10, 700, 30), line(right, 120, 52, 480, 30));
    assert.equal(single.length, 1);
    assert.equal(wrapped.length, 1);
    assert.equal(single[0].text, wrapped[0].text);
    assert.equal(single[0].details, wrapped[0].details);
  }
  for (const field of ['우편번호', '전화: 010-1234-5678', '성명: 홍길동']) {
    const candidates = pipeline(line('버들동', 10, 10, 400, 40), line(field, 10, 55, 300, 12), line('716-7', 10, 72, 140, 20));
    assert.ok(candidates.every(c => c.completeness !== COMPLETE), field);
  }
  assert.equal(extract('우편로 12345'), '우편로 12345');
  assert.equal(extract('이름: 홍길동 123\n우편번호: 12345\n버들동 716-7 203호\n배송 메모: 999호'), '버들동 716-7');
  const elementRows = [[line('경기', 10, 10, 60, 30), line('솔내시', 80, 10, 90, 30), line('새움구', 180, 10, 90, 30), line('달선1', 280, 10, 100, 30)],
    [line('로', 10, 52, 30, 30), line('37', 50, 52, 50, 30), line('104동1202호', 110, 52, 200, 30)]];
  const trace = [];
  const road = automaticCandidate(candidatesFromSpatialBlocks(assembleElements(elementRows, trace), {province: '경기도', district: ''}));
  assert.equal(road.text, '경기도 솔내시 새움구 달선1로 37');
  assert.equal(road.details, '104동 1202호');
  assert.ok(trace.some(t => t.includes('관측된 도로명 조각/접미사')));
  const hierarchy = pipeline(line('경기도', 10, 10, 200, 24), line('솔내시 새움구 버들동', 10, 42, 400, 24), line('716-7 203호', 130, 74, 250, 24));
  assert.equal(automaticCandidate(hierarchy)?.text, '경기도 솔내시 새움구 버들동 716-7');
  const building = assembleLines([line('솔내호수타운 가온아파트', 10, 10, 350, 32), line('경기도 솔내시 새움구 가람동로 25', 10, 50, 250, 12), line('전화: 010-1234-5678', 10, 70, 150, 12)]);
  assert.deepEqual(building.map(g => extract(g.text)).filter(Boolean), ['경기도 솔내시 새움구 가람동로 25']);
  assert.ok(building.map(g => extractCandidate(g.text)).filter(Boolean)[0].details.includes('가온아파트'));
  assert.equal(assembleLines([line('뭉암동 118-36', 10, 10, 150, 24), line('눤곡동 814', 250, 10, 140, 24), line('뫼천동 849-25', 10, 42, 170, 24)]).length, 3);
  const distant = assembleLines([line('뭉암동', 10, 10, 80, 20), line('118-36', 260, 60, 100, 20)]);
  assert.equal(distant.length, 2);
  assert.ok(distant.every(g => extract(g.text) == null));
  assert.equal(extract('경기도 솔내시 푸록\n구 차오\n동 123-4'), '경기도 솔내시 푸록구 차오동 123-4');
  assert.equal(extract('가람\n동로 25'), '가람동로 25');
  assert.ok(!(extract('가\n로 25') || '').includes('가람동로'));
  assert.equal(extract('홍길동 010-1234-5678'), null);
  assert.equal(extract('차오동 123-4\n성명: 홍길동\n전화: 010-1234-5678'), '차오동 123-4');
  const detailed = extractCandidate('경기도 솔내시 새움구 가람\n동로 25(모잔동. 솔내호\n수타운 가온아파트) 102동 2\n901호');
  assert.equal(detailed.text, '경기도 솔내시 새움구 가람동로 25');
  assert.ok(detailed.details.includes('2901호'));
  assert.ok(detailed.details.includes('솔내호수타운'));
  assert.notEqual(identity(detailed), identity({...detailed, details: '102동 2902호'}));
  assert.equal(extractCandidate('가람동로\n102동 2901호'), null);
  const room = extractCandidate('가람동로 25\n901호');
  assert.equal(room.text, '가람동로 25');
  assert.equal(room.details, '901호');
  assert.equal(extract('경기도 솔내시 새움구\n가람동로 25'), '경기도 솔내시 새움구 가람동로 25');
  assert.equal(extract('별골로12길123-4'), '별골로12길 123-4');
});

test('paddle boxes are grouped into rows before element assembly', () => {
  const rows = rowsFromBoxes([line('716-7 203호', 180, 55, 200, 30), line('경기 솔내시 새움구 버들동', 10, 10, 500, 30), line('홍길동', 700, 12, 60, 26)]);
  assert.deepEqual(rows.map(r => r.map(e => e.text)), [['경기 솔내시 새움구 버들동', '홍길동'], ['716-7 203호']]);
  const blocks = assembleElements(rows);
  const found = automaticCandidate(candidatesFromSpatialBlocks(blocks, {province: '경기도', district: ''}));
  assert.equal(found?.text, '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(found.details, '203호');
});

test('field report: base number line ending with a phone number', () => {
  const lines = [line('(창구교부시 수기 체크리스트 작성 필)', 195, 340, 635, 42), line('경기도 솔내시 새움구 모잔로', 432, 390, 394, 36),
    line('12,205호(모잔동,구름상가)031-123-4567', 260, 428, 568, 38), line('홍길동 귀하', 662, 470, 164, 36)];
  const found = automaticCandidate(candidatesFromSpatialBlocks(assembleLines(lines), {province: '경기도', district: '솔내시 새움구'}));
  assert.equal(found?.text, '경기도 솔내시 새움구 모잔로 12');
  assert.equal(found.details, '205호');
  assert.equal(extract('경기도 솔내시 새움구 모잔로\n12,205호(모잔동,구름상가)031-123-4567'), '경기도 솔내시 새움구 모잔로 12');
  // A phone number where the base number would be is still never a base number.
  assert.equal(automaticCandidate(pipeline(line('버들동', 10, 10, 240, 20), line('031 123 4567', 10, 38, 240, 20))), null);
});

test('parser: a spaced numbered road is never cut to another road address (as on Android)', () => {
  const texts = t => extractCandidates(t).map(c => c.text);
  assert.deepEqual(texts('헤움로 12길 34'), ['헤움로12길 34']);
  assert.deepEqual(texts('결수대로 123번길 45'), ['결수대로123번길 45']);
  assert.deepEqual(texts('서울특별시 늘남구 헤움로 12 길 34'), ['서울특별시 늘남구 헤움로12길 34']);
  const parts = parseParts('결수대로 123번길 45');
  assert.equal(parts.name, '결수대로123번길');
  assert.equal(parts.number, '45');
  assert.equal(parts.kind, Kind.ROAD);
  // A number followed by a building name that merely starts with 가/길 is still a base number.
  assert.equal(extract('헤움로 12 가든빌딩'), '헤움로 12');
  assert.equal(extract('헤움로 12 길음빌딩'), '헤움로 12');
  assert.deepEqual(texts('울지로3가 12'), ['울지로3가 12']);
  assert.deepEqual(texts('곰로 1가 24'), ['곰로1가 24']);
  assert.equal(classify('울지로3가 12'), Kind.PARCEL);
});

test('labels: a vertical slip label read glued to the address is taken off (as on Android)', () => {
  const real = new Set(['서울특별시', '통상구', '집배로2길', '누정동', '달선로', '분솔구', '보솔동']);
  const strip = text => stripAddressLabels(text, name => real.has(name.replace(/\s/g, '')));
  assert.equal(strip('받서울특별시 통상구\n는집배로 2길 18\n분101동 1203호'), '서울특별시 통상구\n집배로2길 18\n101동 1203호');
  assert.equal(strip('받누정동 123-4'), '누정동 123-4');
  assert.equal(strip('받는분달선로 50'), '달선로 50');
  assert.equal(strip('받서울 통상구 집배로 2길 18'), '서울 통상구 집배로2길 18');
  // The sender's label too.
  assert.equal(strip('보내는분누정동 5'), '누정동 5');
  assert.equal(strip('보내는사람달선로 50'), '달선로 50');
  assert.equal(strip('보통상구 내달선로 50'), '통상구 달선로 50');
  // Real names, unknown words and a label standing apart are left alone.
  assert.equal(strip('분솔구 누정동 5'), '분솔구 누정동 5');
  assert.equal(strip('보솔동 12'), '보솔동 12');
  assert.equal(strip('받가나다 12'), '받가나다 12');
  assert.equal(strip('받는분 서울특별시 통상구 집배로 2길 18'), '받는분 서울특별시 통상구 집배로 2길 18');
  assert.equal(strip('받는분'), '받는분');
  assert.equal(strip('집배로 2길 18'), '집배로 2길 18');
});

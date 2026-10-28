import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {provinceShort, regionLine} from '../dist/region-label.mjs';

test('official short names of 시·도', () => {
  assert.equal(provinceShort('전남광주통합특별시'), '전남광주');
  assert.equal(provinceShort('서울특별시'), '서울');
  assert.equal(provinceShort('강원특별자치도'), '강원');
  assert.equal(provinceShort('전북특별자치도'), '전북');
  assert.equal(provinceShort('충청북도'), '충북');
  assert.equal(provinceShort('세종특별자치시'), '세종');
  assert.equal(provinceShort('우편특별시'), '우편');
});

test('region line with and without the 시·도', () => {
  const region = {province: '전남광주통합특별시', district: '우정시', localities: ['통상면']};
  assert.equal(regionLine(region), '전남광주 우정시 통상면');
  assert.equal(regionLine(region, true), '우정시 통상면');
  assert.equal(regionLine({province: '우편특별시', district: '통상구', localities: []}, true), '통상구');
  assert.equal(regionLine({province: '우편특별시', district: '통상구', localities: ['우정동', '누정동', '소포동']}), '우편 통상구 우정동 외 2');
  assert.equal(regionLine({province: '경기도', district: '', localities: []}, true), '경기');
  assert.equal(regionLine({province: '', district: '', localities: []}), '');
});

test('page and service worker use one cache name and one asset version', () => {
  const read = name => readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
  const sw = read('sw.js').match(/const CACHE='(roadname-assets-v\d+)'/)[1];
  const page = read('app.js').match(/const CACHE = '(roadname-assets-v\d+)'/)[1];
  assert.equal(page, sw);
  const version = sw.match(/v(\d+)$/)[1];
  const html = read('index.html'), list = read('cache-list.json');
  for (const asset of ['app.js', 'style.css']) {
    assert.ok(html.includes(`./${asset}?v=${version}`), `index.html ${asset}`);
    assert.ok(read('sw.js').includes(`./${asset}?v=${version}`), `sw.js ${asset}`);
    assert.ok(list.includes(`./${asset}?v=${version}`), `cache-list ${asset}`);
  }
});

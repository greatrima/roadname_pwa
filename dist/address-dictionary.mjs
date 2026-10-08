// Nationwide name dictionary and correction engine, ported from the Android app
// (AddressDictionary, AddressCandidateEngine, DictionaryUpdater.validate/isOlderVersion).
// Corrections are suggestions only: numbers are never changed and results are never "verified".
import {Kind, COMPLETE, parseParts, normalizeKey, extractCandidates, extractCandidatesFromOcrSamples} from './address-core.mjs';

export const FORMAT_HEADER = '# address-lens-dictionary-v1';
const MATCH_CACHE_LIMIT = 128;
const numbersInName = /\d+/g;
const numbersOf = value => value.match(numbersInName) || [];
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const withinDistrict = (actual, selected) => actual === selected || actual.startsWith(`${selected} `);

export function suffix(value) {
  for (const s of ['특별자치도', '특별자치시', '광역시', '특별시', '대로', '길', '로']) if (value.endsWith(s)) return s;
  return value.slice(-1);
}
export const allowedDistance = length => (length <= 2 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : 3);

export function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({length: right.length + 1}, (_, i) => i), current = new Array(right.length + 1);
  for (let i = 0; i < left.length; i++) {
    current[0] = i + 1;
    for (let j = 0; j < right.length; j++) {
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + (left[i] === right[j] ? 0 : 1));
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

function nameIndex(names) {
  const index = new Map();
  for (const name of names) {
    const key = `${suffix(name)}|${name.length}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(name);
  }
  return index;
}

export class Bucket {
  constructor(localities, roads) {
    this.localities = localities instanceof Set ? localities : new Set(localities);
    this.roads = roads instanceof Map ? roads : new Map(Object.entries(roads || {}).map(([k, v]) => [k, new Set(v)]));
    this.localityIndex = null;
    this.roadIndex = null;
  }
  *names(kind, targetSuffix, minimumLength, maximumLength) {
    if (kind === Kind.ROAD) this.roadIndex ??= nameIndex(this.roads.keys());
    else this.localityIndex ??= nameIndex(this.localities);
    const index = kind === Kind.ROAD ? this.roadIndex : this.localityIndex;
    for (let length = minimumLength; length <= maximumLength; length++) yield* index.get(`${targetSuffix}|${length}`) || [];
  }
}

export class AddressDictionary {
  /** buckets: Map<province, Map<district, Bucket>> (insertion order = file order). */
  constructor(buckets, version = 'test') {
    this.buckets = buckets;
    this.version = version;
    this.matchCache = new Map();
    this.exactNames = null;
  }

  /** Exact names only, no fuzzy correction: provinces, districts and their words, localities and roads. */
  isExactAddressName(value) {
    if (!this.exactNames) {
      const names = this.exactNames = new Set();
      for (const [province, districts] of this.buckets) {
        names.add(province);
        for (const [district, bucket] of districts) {
          names.add(district.replace(/ /g, ''));
          for (const part of district.split(' ')) names.add(part);
          for (const locality of bucket.localities) names.add(locality);
          for (const road of bucket.roads.keys()) names.add(road);
        }
      }
    }
    return this.exactNames.has(value.replace(/\s+/g, ''));
  }

  static fromObject(object, version = 'test') {
    return new AddressDictionary(new Map(Object.entries(object).map(([province, districts]) =>
      [province, new Map(Object.entries(districts).map(([district, b]) => [district, new Bucket(b.localities || [], b.roads || {})]))])), version);
  }

  /** Parses the Android TSV format. Throws on unsupported or empty data. */
  static parse(text) {
    const lines = text.split(/\r?\n/);
    if (lines[0] !== FORMAT_HEADER) throw new Error('지원하지 않는 사전입니다.');
    const buckets = new Map(), intern = new Map();
    const shared = value => { let v = intern.get(value); if (v === undefined) { intern.set(value, value); v = value; } return v; };
    let version = '내장본', entryCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('# generated=')) { version = line.slice(line.indexOf('=') + 1); continue; }
      if (!line.trim() || line.startsWith('#')) continue;
      const fields = line.split('\t');
      if (fields.length < 4 || (fields[0] !== 'A' && fields[0] !== 'R')) continue;
      const [type, province, district, locality] = fields;
      if (!province.trim() || !district.trim()) continue;
      let districts = buckets.get(province);
      if (!districts) buckets.set(province, districts = new Map());
      let bucket = districts.get(district);
      if (!bucket) districts.set(district, bucket = new Bucket(new Set(), new Map()));
      const name = shared(locality);
      if (locality.trim() && !bucket.localities.has(name)) { bucket.localities.add(name); entryCount++; }
      if (type === 'R' && fields.length >= 5 && fields[4].trim()) {
        let roadLocalities = bucket.roads.get(fields[4]);
        if (!roadLocalities) { bucket.roads.set(fields[4], roadLocalities = new Set()); entryCount++; }
        if (locality.trim()) roadLocalities.add(name);
      }
    }
    if (!entryCount) throw new Error('사전에 주소 항목이 없습니다.');
    return new AddressDictionary(buckets, version);
  }

  provinces() { return [...this.buckets.keys()].sort(compareText); }
  districts(province) {
    const keys = [...(this.buckets.get(province)?.keys() || [])];
    return [...new Set(keys.flatMap(k => [k.split(' ')[0], k]))].sort(compareText);
  }
  localities(province, district) {
    const names = new Set();
    for (const [key, bucket] of this.buckets.get(province) || []) if (withinDistrict(key, district)) for (const n of bucket.localities) names.add(n);
    return [...names].sort(compareText);
  }
  /** {provinces: {province: {district: [names]}}} used by the locality suggestion module. */
  localityTree() {
    const provinces = {};
    for (const [province, districts] of this.buckets) {
      provinces[province] = {};
      for (const [district, bucket] of districts) provinces[province][district] = [...bucket.localities];
    }
    return {version: this.version, provinces};
  }

  match(name, kind, region = {}, explicitProvince = null) {
    const key = JSON.stringify([name, kind, region.province || '', region.district || '', [...(region.localities || [])].sort(), explicitProvince || '']);
    if (this.matchCache.has(key)) return this.matchCache.get(key);
    const result = this.findMatches(name, kind, region, explicitProvince);
    this.matchCache.set(key, result);
    while (this.matchCache.size > MATCH_CACHE_LIMIT) this.matchCache.delete(this.matchCache.keys().next().value);
    return result;
  }

  findMatches(name, kind, region, explicitProvince) {
    const targetSuffix = suffix(name), limit = allowedDistance(name.length);
    const minimum = Math.max(0, name.length - limit), maximum = name.length + limit;
    const numberTokens = numbersOf(name);
    const localities = new Set(region.localities || []);
    const search = (provinces, districtOnly = null) => {
      const matches = [];
      for (const province of provinces) {
        const districts = this.buckets.get(province);
        if (!districts) continue;
        for (const [district, bucket] of districts) {
          if (districtOnly != null && !withinDistrict(district, districtOnly)) continue;
          for (const candidate of bucket.names(kind, targetSuffix, minimum, maximum)) {
            // Correct letters, never invent/delete/change numbers in a road or locality.
            if (!sameList(numbersOf(candidate), numberTokens)) continue;
            const distance = levenshtein(name, candidate);
            if (distance > limit) continue;
            const context = !localities.size || (kind === Kind.ROAD
              ? [...(bucket.roads.get(candidate) || [])].some(l => localities.has(l)) : localities.has(candidate));
            matches.push({province, district, name: candidate, kind, distance: distance + (context ? 0 : 1), localityContext: context});
          }
        }
      }
      return matches.sort((a, b) => (a.distance - b.distance) || (b.localityContext - a.localityContext) ||
        compareText(a.province, b.province) || compareText(a.district, b.district) || compareText(a.name, b.name)).slice(0, 8);
    };
    const preferred = explicitProvince || region.province || null;
    if (preferred) {
      if (region.district) {
        const found = search([preferred], region.district);
        if (found.length) return found;
      }
      const found = search([preferred]);
      if (found.length) return found;
      // An explicit region is authoritative; do not "correct" it to an unrelated province.
      if (explicitProvince) return [];
    }
    return search(this.buckets.keys());
  }

  correctProvince(token) { return bestToken(token, [...this.buckets.keys()]); }
  correctDistrict(token, province) {
    const preferred = province ? this.districts(province) : [];
    return bestDistrictToken(token, preferred) ?? bestDistrictToken(token, [...new Set(this.provinces().flatMap(p => this.districts(p)))]);
  }
  provinceForDistrict(district, preferredProvince = null) {
    if (preferredProvince && [...(this.buckets.get(preferredProvince)?.keys() || [])].some(k => withinDistrict(k, district))) return preferredProvince;
    for (const [province, districts] of this.buckets) if ([...districts.keys()].some(k => withinDistrict(k, district))) return province;
    return null;
  }
}

function bestToken(token, values) {
  let best = null;
  for (const value of values) {
    if (suffix(value) !== suffix(token)) continue;
    const distance = levenshtein(token, value);
    if (distance > allowedDistance(token.length)) continue;
    if (!best || distance < best[1] || (distance === best[1] && value < best[0])) best = [value, distance];
  }
  return best?.[0] ?? null;
}
function bestDistrictToken(token, values) {
  if (!values.length) return null;
  if (values.includes(token)) return token;
  let best = null;
  for (const district of values) {
    for (const part of [district, ...district.split(/\s+/)]) {
      if (suffix(part) !== suffix(token)) continue;
      const distance = levenshtein(token, part);
      if (distance > allowedDistance(token.length)) continue;
      if (!best || distance < best[1] || (distance === best[1] && district < best[0])) best = [district, distance];
    }
  }
  return best?.[0] ?? null;
}

const isProvinceToken = t => /(?:도|광역시|특별시|특별자치시)$/.test(t);
const isDistrictToken = t => /(?:시|군|구)$/.test(t);
const isIntermediateRegionToken = t => /(?:읍|면)$/.test(t);
const regionEmpty = region => !region?.province && !region?.district;

export class AddressCandidateEngine {
  constructor(dictionary) { this.dictionary = dictionary; }

  candidates(rawBlocks, region = {}) {
    const seen = new Set();
    return extractCandidatesFromOcrSamples(rawBlocks, true).flatMap(c => this.correct(c, region))
      .filter(c => { const k = normalizeKey(c.text); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => ((b.completeness === COMPLETE) - (a.completeness === COMPLETE)) || (b.confidence - a.confidence) || compareText(a.text, b.text))
      .slice(0, 5);
  }

  candidate(raw, region = {}) { return extractCandidates(raw).flatMap(c => this.correct(c, region))[0] || null; }

  correct(candidate, region = {}) {
    const dictionary = this.dictionary, parts = parseParts(candidate.text);
    if (!parts) return [candidate];
    const explicitProvinceToken = parts.prefix.find(isProvinceToken) ?? null;
    const explicitProvince = explicitProvinceToken ? dictionary.correctProvince(explicitProvinceToken) : null;
    const districtToken = [...parts.prefix].reverse().find(isDistrictToken) ?? null;
    const explicitDistrict = districtToken ? dictionary.correctDistrict(districtToken, explicitProvince ?? (region.province || null)) : null;
    const resolvedProvince = explicitProvince ?? (explicitDistrict ? dictionary.provinceForDistrict(explicitDistrict, region.province || null) : null);
    const lookupRegion = resolvedProvince ? {province: resolvedProvince, district: explicitDistrict || '', localities: region.localities || []} : region;
    const matches = dictionary.match(parts.name, parts.kind, lookupRegion, resolvedProvince);
    const intermediate = parts.prefix.filter(isIntermediateRegionToken);
    if (!matches.length) {
      const fallbackText = !parts.prefix.length && !regionEmpty(region)
        ? [region.province, region.district, candidate.text].filter(Boolean).join(' ') : candidate.text;
      return [{...candidate, text: fallbackText, confidence: Math.min(candidate.confidence, 65), dictionaryCorrected: fallbackText !== candidate.text}];
    }
    return matches.slice(0, 5).map(match => {
      const prefix = [...new Set([match.province, match.district, ...intermediate])];
      const number = parts.number != null ? `${parts.mountain ? '산 ' : ''}${parts.number}` : null;
      const text = ([...prefix, match.name].join(' ') + (number != null ? ` ${number}` : '')).trim();
      const corrected = match.name !== parts.name || explicitProvinceToken !== explicitProvince ||
        (districtToken != null && districtToken !== explicitDistrict) || (!parts.prefix.length && !regionEmpty(region));
      return {...candidate, text, confidence: Math.max(50, Math.min(100, 100 - match.distance * 12 + (match.localityContext ? 5 : 0))),
        dictionaryCorrected: corrected, verified: false};
    });
  }
}

/** DictionaryUpdater.validate on decoded text: returns the version or throws. */
export function validateDictionaryText(text) {
  if (text.length > 100_000_000) throw new Error('사전 압축 해제 크기가 너무 큽니다.');
  const lines = text.split(/\r?\n/);
  if (lines[0] !== FORMAT_HEADER) throw new Error('지원하지 않는 사전입니다.');
  if (!lines[1]?.startsWith('# generated=')) throw new Error('사전 버전 정보가 없습니다.');
  const version = lines[1].slice(lines[1].indexOf('=') + 1).trim() || '갱신본';
  let entries = 0;
  for (const line of lines.slice(2)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 4 || !f[1].trim() || !f[2].trim()) throw new Error('사전 항목 형식이 올바르지 않습니다.');
    if (f[0] === 'A') { if (f[3].trim()) entries++; }
    else if (f[0] === 'R') { if (f.length < 5 || !f[4].trim()) throw new Error('도로명 사전 항목 형식이 올바르지 않습니다.'); entries++; }
    else throw new Error('알 수 없는 사전 항목입니다.');
  }
  if (!entries) throw new Error('사전에 주소 항목이 없습니다.');
  return version;
}

export function isOlderVersion(downloaded, installed) {
  const date = /\d{4}-\d{2}-\d{2}/;
  const remote = downloaded.match(date)?.[0], local = installed.match(date)?.[0];
  return !!remote && !!local && remote < local;
}

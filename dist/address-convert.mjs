// Parcel ↔ road conversion, ported from the Android AddressConverter.
// Browser constraints: VWorld is called with JSONP (no CORS) and Kakao Local with fetch (CORS allowed).
// Naver geocoding has no CORS support, so it is not available in the web app.
// Only the extracted base address is sent. Details, names and photos never leave the device.
import {Kind, extract, classify, normalizeKey, validatedParts, exactMatch} from './address-core.mjs';

export const Source = Object.freeze({VWORLD: 'VWORLD', KAKAO: 'KAKAO'});
export const SOURCE_LABEL = Object.freeze({VWORLD: 'VWorld', KAKAO: '카카오맵', LOCAL: '내 지역 주소 자료'});

export const outcome = {
  success: result => ({type: 'success', result}),
  apiKeyMissing: () => ({type: 'apiKeyMissing'}),
  notFound: () => ({type: 'notFound'}),
  offline: () => ({type: 'offline'}),
  noExactMatch: suggestions => ({type: 'noExactMatch', suggestions}),
  networkError: message => ({type: 'networkError', message}),
};

const hasCityOrDistrict = address => address.split(/\s+/).some(t => /(?:도|시|군|구)$/.test(t));

export function qualifyAddress(target, reference) {
  const cleanedTarget = target.split(' (')[0].trim();
  if (!cleanedTarget || hasCityOrDistrict(cleanedTarget)) return cleanedTarget;
  const tokens = reference.split(' (')[0].trim().split(/\s+/);
  let last = -1;
  tokens.forEach((t, i) => { if (/(?:도|시|군|구)$/.test(t)) last = i; });
  if (last < 0) return cleanedTarget;
  return `${tokens.slice(0, last + 1).join(' ')} ${cleanedTarget}`.trim();
}

export function matchRows(query, kind, rows, source) {
  const effectiveKind = kind === Kind.UNKNOWN ? classify(query) : kind;
  const parcel = effectiveKind === Kind.PARCEL;
  const possible = [];
  const seen = new Set();
  for (const row of rows) {
    const names = parcel ? [row.parcel, ...(row.related || [])] : [row.road];
    for (const name of names) {
      const recognized = extract(qualifyAddress(name, parcel ? row.road : row.parcel)) || '';
      const converted = extract(parcel ? qualifyAddress(row.road, name) : qualifyAddress(row.parcel, row.road)) || '';
      if (validatedParts(recognized)?.number == null || validatedParts(converted)?.number == null) continue;
      const key = `${normalizeKey(recognized)}|${normalizeKey(converted)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      possible.push({recognizedAddress: recognized, convertedAddress: converted, recognizedKind: effectiveKind, source});
    }
  }
  const exact = possible.filter(p => exactMatch(query, p.recognizedAddress));
  // An omitted region can match several real addresses. Never pick the first arbitrarily.
  if (exact.length === 1) return outcome.success(exact[0]);
  if (possible.length) return outcome.noExactMatch((exact.length ? exact : possible).slice(0, 3));
  return outcome.notFound();
}

export function selectOutcome(outcomes) {
  if (outcomes.some(o => o.type === 'offline')) return outcome.offline();
  // A failed provider is not evidence that the address does not exist.
  const errors = outcomes.filter(o => o.type === 'networkError');
  if (errors.length) return errors[errors.length - 1];
  const similar = outcomes.filter(o => o.type === 'noExactMatch');
  if (similar.length) {
    const seen = new Set();
    return outcome.noExactMatch(similar.flatMap(o => o.suggestions).filter(s => {
      const key = normalizeKey(s.recognizedAddress);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3));
  }
  return outcome.notFound();
}

export function parseVworld(query, kind, body) {
  const response = body?.response;
  if (!response) return outcome.networkError('VWorld 응답 형식 오류');
  if (response.status === 'NOT_FOUND') return outcome.notFound();
  if (response.status === 'ERROR') return outcome.networkError(response.error?.text || 'VWorld API 오류');
  const items = response.result?.items;
  if (!Array.isArray(items)) return outcome.notFound();
  const rows = items.map(i => i?.address).filter(Boolean)
    .map(a => ({parcel: String(a.parcel || '').trim(), road: String(a.road || '').trim()}));
  return matchRows(query, kind, rows, Source.VWORLD);
}

export function parseKakao(query, kind, body) {
  const documents = body?.documents;
  if (!Array.isArray(documents)) return outcome.notFound();
  const rows = documents.filter(Boolean).map(d => ({parcel: String(d.address?.address_name || '').trim(),
    road: String(d.road_address?.address_name || '').trim()}));
  return matchRows(query, kind, rows, Source.KAKAO);
}

let jsonpSequence = 0;
export function jsonp(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const name = `__roadnameJsonp${Date.now().toString(36)}${jsonpSequence++}`;
    const script = document.createElement('script');
    const done = (fn, value) => { clearTimeout(timer); delete window[name]; script.remove(); fn(value); };
    const timer = setTimeout(() => done(reject, Object.assign(new Error('timeout'), {timeout: true})), timeoutMs);
    window[name] = data => done(resolve, data);
    script.onerror = () => done(reject, new Error('load'));
    script.src = `${url}&callback=${name}`;
    document.head.append(script);
  });
}

const MAX_CACHE = 64;

export class AddressConverter {
  constructor({getKeys, isOnline = () => navigator.onLine, loadJsonp = jsonp, fetchImpl = (...a) => fetch(...a),
    origin = () => location.origin} = {}) {
    this.getKeys = getKeys;
    this.isOnline = isOnline;
    this.loadJsonp = loadJsonp;
    this.fetchImpl = fetchImpl;
    this.origin = origin;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  keys() {
    const keys = this.getKeys?.() || {};
    return {vworld: String(keys.vworld || '').trim(), kakao: String(keys.kakao || '').trim()};
  }

  async convert(query) {
    const cleaned = extract(query) || query.trim();
    const keys = this.keys();
    const cacheKey = `${normalizeKey(cleaned)}:${keys.vworld}:${keys.kakao}`;
    const cached = this.cache.get(cacheKey);
    // A verified result can be reused; a cached miss must not hide the immediate offline response.
    if (cached?.type === 'success') return cached;
    if (!this.isOnline()) return outcome.offline();
    if (cached) return cached;
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey);
    const pending = this.run(cleaned, keys).then(result => {
      this.inFlight.delete(cacheKey);
      if (['success', 'notFound', 'noExactMatch'].includes(result.type)) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, result);
        while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
      }
      return result;
    });
    this.inFlight.set(cacheKey, pending);
    return pending;
  }

  async run(query, keys) {
    const kind = classify(query);
    const outcomes = [];
    if (keys.vworld) {
      const result = await this.requestVworld(query, kind, keys.vworld);
      if (result.type === 'success') return result;
      outcomes.push(result);
    }
    if (keys.kakao) {
      const result = await this.requestKakao(query, kind, keys.kakao);
      if (result.type === 'success') return result;
      outcomes.push(result);
    }
    return outcomes.length ? selectOutcome(outcomes) : outcome.apiKeyMissing();
  }

  failure(message) {
    return this.isOnline() ? outcome.networkError(message) : outcome.offline();
  }

  async requestVworld(query, kind, key) {
    const categories = kind === Kind.PARCEL ? ['parcel'] : kind === Kind.ROAD ? ['road'] : ['parcel', 'road'];
    const results = await Promise.all(categories.map(async category => {
      const url = 'https://api.vworld.kr/req/search?service=search&request=search&version=2.0&format=json&errorFormat=json' +
        `&size=10&page=1&type=address&category=${category}&query=${encodeURIComponent(query)}` +
        `&key=${encodeURIComponent(key)}&domain=${encodeURIComponent(this.origin())}`;
      try {
        return parseVworld(query, kind, await this.loadJsonp(url));
      } catch (error) {
        return this.failure(error?.timeout ? 'VWorld 응답 없음 · 키에 이 사이트 주소가 등록됐는지 확인하세요.' : 'VWorld 주소 서버 연결 오류');
      }
    }));
    return results.find(r => r.type === 'success') || selectOutcome(results);
  }

  async requestKakao(query, kind, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await this.fetchImpl(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=10`,
        {headers: {Authorization: `KakaoAK ${key}`}, signal: controller.signal, cache: 'no-store'});
      if (!response.ok) return outcome.networkError(`카카오맵 주소 서버 응답 코드 ${response.status}`);
      return parseKakao(query, kind, await response.json());
    } catch {
      return this.failure('카카오맵 주소 서버 연결 오류');
    } finally {
      clearTimeout(timer);
    }
  }
}


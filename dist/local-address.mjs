// "내 지역 주소 자료": one 시·군·구's road address <-> parcel pairs (Ministry of the Interior and Safety public data,
// split by scripts/local-data.py), kept on the phone so the region's addresses convert without the address servers,
// offline too. Anything not found here is asked of the servers as before.
import {extract, parseParts, normalizeKey, Kind} from './address-core.mjs';
import {distance, jamo} from './address-memory.mjs';

export const LOCAL_SOURCE = 'LOCAL';
const HEADER = '# address-lens-local-v1';

/** The district file read into lookup tables; null when it is no such file. */
export function parseLocal(text) {
  const lines = String(text || '').split('\n');
  if (lines[0]?.trim() !== HEADER) return null;
  // Several district files joined (mergeLocal) each start with their own "# district=" line.
  const meta = {}, titles = [], roads = [], localities = [], byRoad = new Map(), byParcel = new Map(), byName = new Map();
  const addParcel = (loc, parcel, building) => {
    for (const key of [`${loc}|${parcel}`, `${loc.split(' ').pop()}|${parcel}`]) {
      const list = byParcel.get(key) || [];
      if (!list.includes(building)) list.push(building);
      byParcel.set(key, list);
    }
  };
  for (const line of lines) {
    if (line.startsWith('# ')) {
      const [k, v] = line.slice(2).split('=');
      if (v !== undefined) meta[k.trim()] = v.trim();
      if (v !== undefined && k.trim() === 'district') titles.push(v.trim());
      continue;
    }
    const c = line.split('\t');
    if (c[0] === 'R') roads.push(c[1]);
    else if (c[0] === 'L') localities.push(c[1]);
    else if (c[0] === 'B' && c.length >= 5) {
      const building = {road: roads[+c[1]], number: c[2], locality: localities[+c[3]], parcel: c[4], name: c[6] || '', region: titles.at(-1) || ''};
      byRoad.set(`${building.road}|${building.number}`, building);
      if (building.name.length >= 2) byName.set(building.name, [...(byName.get(building.name) || []), building]);
      addParcel(building.locality, building.parcel, building);
      for (const more of (c[5] || '').split(';').filter(Boolean)) {
        const [l, parcel] = more.split(':');
        addParcel(localities[+l], parcel, building);
      }
    }
  }
  const [province = ''] = (titles[0] || '').split(' ');
  const districts = titles.map(t => t.split(' ').slice(1).join(' '));
  // One district, or the 시 that several 구 share ("안산시"); every 시·군·구 word counts as this data's own.
  const district = districts.length === 1 ? districts[0] : (districts[0] || '').split(' ')[0];
  const districtWords = new Set(districts.flatMap(d => d.split(' ')).filter(Boolean));
  // Longest names first, so "한빛아파트 2단지" is found before "한빛아파트".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  // Building numbers of each road ("50", "u396") and parcels of each 동·리 ("127", "산12").
  const roadNumbers = new Map(), parcelNumbers = new Map();
  for (const b of byRoad.values()) roadNumbers.set(b.road, (roadNumbers.get(b.road) || new Set()).add(b.number));
  for (const key of byParcel.keys()) { const [l, p] = key.split('|'); parcelNumbers.set(l, (parcelNumbers.get(l) || new Set()).add(p)); }
  return {version: meta.version || '', province, district, districtWords, byRoad, byParcel, byName, names, roadNumbers, parcelNumbers};
}

/** A 시·군·구 named in the address that is not this district's: the address is someone else's to look up. */
function otherDistrict(parts, data) {
  return parts.prefix.some(t => /(?:시|군|구)$/.test(t) && !/(?:특별시|광역시|특별자치시)$/.test(t) && !data.districtWords.has(t));
}

/**
 * District files joined into one (a whole 시 of several 구), as the app's LocalAddressData.merge: each keeps its
 * "# district=" line, its roads and localities numbered on after the ones before.
 */
export function mergeLocal(texts) {
  if (texts.length === 1) return texts[0];
  const out = [HEADER];
  let roadBase = 0, localityBase = 0, versionDone = false;
  for (const text of texts) {
    let roads = 0, localities = 0;
    for (const line of String(text).split('\n')) {
      if (!line || line.trim() === HEADER) continue;
      if (line.startsWith('# version=')) { if (!versionDone) { out.push(line); versionDone = true; } }
      else if (line.startsWith('# ')) out.push(line);
      else if (line.startsWith('R\t')) { out.push(line); roads++; }
      else if (line.startsWith('L\t')) { out.push(line); localities++; }
      else if (line.startsWith('B\t')) {
        const c = line.split('\t');
        c[1] = String(+c[1] + roadBase); c[3] = String(+c[3] + localityBase);
        if (c[5]) c[5] = c[5].split(';').map(m => { const [i, p] = m.split(':'); return `${+i + localityBase}:${p}`; }).join(';');
        out.push(c.join('\t'));
      }
    }
    roadBase += roads; localityBase += localities;
  }
  return out.join('\n') + '\n';
}

/**
 * The index entries for a region: its district, every 구 of a 시 chosen without one ("안산시" takes 안산시 단원구 and
 * 안산시 상록구), and 세종, whose data names no 시·군·구.
 */
export function localEntries(districts, region) {
  const same = districts.filter(d => d.province === region.province);
  const exact = same.filter(d => d.district === region.district);
  if (exact.length) return exact;
  const city = same.filter(d => d.district.startsWith(`${region.district} `));
  if (city.length) return city;
  return same.filter(d => d.district === '' && region.district === region.province);
}

/** The building whose name the text carries ("누정동 한빛아파트 104동"), when that name means one road address. */
export function buildingByName(data, text) {
  if (!data) return null;
  const compact = String(text || '').replace(/\s+/g, '');
  for (const name of data.names) {
    if (name.length < 3 || !compact.includes(name.replace(/\s+/g, ''))) continue;
    const found = data.byName.get(name), first = found[0];
    return found.every(b => b.road === first.road && b.number === first.number) ? first : null;
  }
  return null;
}

/**
 * {recognizedAddress, convertedAddress, recognizedKind, source, buildingName} for `query`, or null when this district
 * cannot tell. An address without a number is found by a building name it carries.
 */
export function lookupLocal(data, query) {
  if (!data) return null;
  const parts = parseParts(extract(query) ?? query);
  const road = b => `${b.region} ${b.road} ${b.number.replace(/^u/, '지하 ')}`;
  const parcel = b => `${b.region} ${b.locality} ${b.parcel.replace(/^산/, '산 ')}`;
  const result = (b, recognizedAddress, convertedAddress, recognizedKind) =>
    ({recognizedAddress, convertedAddress, recognizedKind, source: LOCAL_SOURCE, buildingName: b.name || ''});
  if (!parts || parts.number == null) {
    const b = buildingByName(data, query);
    // Only words before the name: a district named there that is not this one.
    const named = {prefix: String(query).split(/\s+/)};
    return b && !otherDistrict(named, data) ? result(b, road(b), parcel(b), Kind.ROAD) : null;
  }
  if (otherDistrict(parts, data)) return null;
  if (parts.kind === Kind.ROAD) {
    const b = data.byRoad.get(`${parts.name}|${parts.number}`);
    return b ? result(b, road(b), parcel(b), Kind.ROAD) : null;
  }
  const key = `${parts.name}|${parts.mountain ? '산' : ''}${parts.number}`;
  const found = data.byParcel.get(key) || [];
  // One parcel with several road addresses (a large site) is left to the servers, which list them.
  const roads = [...new Set(found.map(road))];
  if (roads.length !== 1) return null;
  const b = found[0];
  return result(b, `${b.region} ${b.locality} ${parts.mountain ? '산 ' : ''}${parts.number}`, roads[0], Kind.PARCEL);
}

const NAMED_NUMBER = /([가-힣][가-힣0-9]*[가-힣])\s*(산\s*)?(\d{1,5}(?:-\d{1,4})?)(?![\d-])/g;

/**
 * The camera's reading with misread road and 동 names put right (same rules as the app's correctNames): a word
 * before a number ("다슬로 175", "타슬로 175", "다솔르 175") that is no name of this district becomes the name of this
 * district that looks most like it (up to two letter parts apart, one for short words; the numbers inside a name,
 * as in 종로43길, must be the same) and has that very number. A tie between names, or none: left as read.
 */
export function correctNames(data, text) {
  if (!data) return text;
  const digits = s => s.replace(/\D/g, '');
  data.nameTable ??= [...data.roadNumbers, ...data.parcelNumbers].map(([name, numbers]) => ({name, jamo: jamo(name), digits: digits(name), numbers}));
  return String(text).replace(NAMED_NUMBER, (whole, word, mountain, number) => {
    if (data.roadNumbers.has(word) || data.parcelNumbers.has(word)) return whole;
    const key = (mountain ? '산' : '') + number, typed = jamo(word), limit = typed.length >= 6 ? 2 : 1;
    const inside = digits(word);
    const hits = data.nameTable.filter(n => n.digits === inside && n.numbers.has(key))
      .map(n => ({name: n.name, d: distance(n.jamo, typed, limit)})).filter(h => h.d <= limit);
    const best = Math.min(...hits.map(h => h.d)), nearest = hits.filter(h => h.d === best);
    return nearest.length === 1 ? whole.replace(word, nearest[0].name) : whole;
  });
}

// ---- the region found by itself, for those who chose none: the 시·군·구 of the addresses converted lately ----
export const RECENT = 20, ENOUGH = 3;

/**
 * `recent` with a server-converted address added: its 시·군·구 and a key of the address, newest first, each address
 * once (a bulk sender's 100 letters count as one), at most RECENT. Addresses of the region's own data add nothing.
 */
export function rememberDistrict(recent, result) {
  if (!result || result.source === LOCAL_SOURCE) return recent;
  const parts = parseParts(result.convertedAddress) || parseParts(result.recognizedAddress);
  const district = parts?.prefix.slice(1).join(' ');
  if (!parts || !parts.prefix[0] || !district) return recent;
  const key = normalizeKey(result.convertedAddress), entry = {key, district: `${parts.prefix[0]}|${district}`};
  return [entry, ...(recent || []).filter(e => e.key !== key)].slice(0, RECENT);
}

/** {province, district} that most of the recent addresses are in, when ENOUGH of them are and none ties it. */
export function autoDistrict(recent) {
  const counts = new Map();
  for (const e of recent || []) counts.set(e.district, (counts.get(e.district) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < ENOUGH || ranked[1]?.[1] === ranked[0][1]) return null;
  const [province, district] = ranked[0][0].split('|');
  return {province, district};
}

/** Text of a gzip file. */
export async function gunzipText(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

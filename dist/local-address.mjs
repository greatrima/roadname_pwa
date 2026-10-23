// "내 지역 주소 자료": one 시·군·구's road address <-> parcel pairs (Ministry of the Interior and Safety public data,
// split by scripts/local-data.py), kept on the phone so the region's addresses convert without the address servers,
// offline too. Anything not found here is asked of the servers as before.
import {extract, parseParts, Kind, COMPLETE} from './address-core.mjs';
import {distance, jamo} from './address-memory.mjs';

export const LOCAL_SOURCE = 'LOCAL';
const HEADER = '# address-lens-local-v1';

/** The district file read into lookup tables; null when it is no such file. */
export function parseLocal(text) {
  const lines = String(text || '').split('\n');
  if (lines[0]?.trim() !== HEADER) return null;
  const meta = {}, roads = [], localities = [], byRoad = new Map(), byParcel = new Map(), byName = new Map();
  const addParcel = (loc, parcel, building) => {
    for (const key of [`${loc}|${parcel}`, `${loc.split(' ').pop()}|${parcel}`]) {
      const list = byParcel.get(key) || [];
      if (!list.includes(building)) list.push(building);
      byParcel.set(key, list);
    }
  };
  for (const line of lines) {
    if (line.startsWith('# ')) { const [k, v] = line.slice(2).split('='); if (v !== undefined) meta[k.trim()] = v.trim(); continue; }
    const c = line.split('\t');
    if (c[0] === 'R') roads.push(c[1]);
    else if (c[0] === 'L') localities.push(c[1]);
    else if (c[0] === 'B' && c.length >= 5) {
      const building = {road: roads[+c[1]], number: c[2], locality: localities[+c[3]], parcel: c[4], name: c[6] || ''};
      byRoad.set(`${building.road}|${building.number}`, building);
      if (building.name.length >= 2) byName.set(building.name, [...(byName.get(building.name) || []), building]);
      addParcel(building.locality, building.parcel, building);
      for (const more of (c[5] || '').split(';').filter(Boolean)) {
        const [l, parcel] = more.split(':');
        addParcel(localities[+l], parcel, building);
      }
    }
  }
  const [province = '', ...rest] = (meta.district || '').split(' ');
  // Longest names first, so "한빛아파트 2단지" is found before "한빛아파트".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  // Building numbers of each road ("50", "u396") and parcels of each 동·리 ("127", "산12").
  const roadNumbers = new Map(), parcelNumbers = new Map();
  for (const b of byRoad.values()) roadNumbers.set(b.road, (roadNumbers.get(b.road) || new Set()).add(b.number));
  for (const key of byParcel.keys()) { const [l, p] = key.split('|'); parcelNumbers.set(l, (parcelNumbers.get(l) || new Set()).add(p)); }
  return {version: meta.version || '', province, district: rest.join(' '), byRoad, byParcel, byName, names, roadNumbers, parcelNumbers};
}

/** A 시·군·구 named in the address that is not this district's: the address is someone else's to look up. */
function otherDistrict(parts, data) {
  const words = data.district.split(' ');
  return parts.prefix.some(t => /(?:시|군|구)$/.test(t) && !/(?:특별시|광역시|특별자치시)$/.test(t) && !words.includes(t));
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
  const region = `${data.province} ${data.district}`;
  const road = b => `${region} ${b.road} ${b.number.replace(/^u/, '지하 ')}`;
  const parcel = b => `${region} ${b.locality} ${b.parcel.replace(/^산/, '산 ')}`;
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
  return result(b, `${region} ${b.locality} ${parts.mountain ? '산 ' : ''}${parts.number}`, roads[0], Kind.PARCEL);
}

export const CORRECTED = '지역 자료 보정', MISSING = '지역에 없는 번지';
const oneEdit = (a, b) => a !== b && Math.abs(a.length - b.length) <= 1 && distance(a, b, 2) === 1;

/**
 * What the camera read, checked against the region's data (same rules as the app's RegionCorrection): a number
 * the road has is real; one it lacks is never converted by itself, and the road's numbers one digit away (up to 3)
 * are offered to choose (not swapped in: house numbers are packed so close that such a guess was wrong almost as
 * often as right on real data); a name the region lacks, one letter away from exactly one that has this number, is
 * offered as a candidate. Another district, or no data: unchanged.
 */
export function correctCandidates(candidates, data) {
  if (!data) return candidates;
  return candidates.flatMap(c => {
    if (c.completeness !== COMPLETE || c.manualOnly) return [c];
    const parts = parseParts(c.text);
    if (!parts || parts.number == null || otherDistrict(parts, data)) return [c];
    const road = parts.kind === Kind.ROAD, mark = road ? '' : parts.mountain ? '산' : '', key = mark + parts.number;
    const table = road ? data.roadNumbers : data.parcelNumbers, known = table.get(parts.name);
    if (known) {
      if (known.has(key)) return [c];
      const near = [...known].filter(n => n.startsWith(mark) && /^\d/.test(n.slice(mark.length)) && oneEdit(n, key));
      const at = c.text.lastIndexOf(parts.number), offered = near.length <= 3 ? near.sort() : [];
      return [{...c, manualOnly: true, reviewReason: MISSING}, ...offered.map(n => ({...c,
        text: c.text.slice(0, at) + n.slice(mark.length) + c.text.slice(at + parts.number.length), manualOnly: true, dictionaryCorrected: true, reviewReason: CORRECTED}))];
    }
    const typed = jamo(parts.name), names = [...table.keys()].filter(n => distance(jamo(n), typed, 2) <= 1 && table.get(n).has(key));
    if (names.length !== 1) return [c];
    const at = c.text.lastIndexOf(parts.name);
    return [c, {...c, text: c.text.slice(0, at) + names[0] + c.text.slice(at + parts.name.length), manualOnly: true, dictionaryCorrected: true, reviewReason: CORRECTED}];
  });
}

/** Text of a gzip file. */
export async function gunzipText(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// "내 지역 주소 자료": one 시·군·구's road address <-> parcel pairs (Ministry of the Interior and Safety public data,
// split by scripts/local-data.py), kept on the phone so the region's addresses convert without the address servers,
// offline too. Anything not found here is asked of the servers as before.
import {extract, parseParts, Kind} from './address-core.mjs';

export const LOCAL_SOURCE = 'LOCAL';
const HEADER = '# address-lens-local-v1';

/** The district file read into lookup tables; null when it is no such file. */
export function parseLocal(text) {
  const lines = String(text || '').split('\n');
  if (lines[0]?.trim() !== HEADER) return null;
  const meta = {}, roads = [], localities = [], byRoad = new Map(), byParcel = new Map();
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
      const building = {road: roads[+c[1]], number: c[2], locality: localities[+c[3]], parcel: c[4]};
      byRoad.set(`${building.road}|${building.number}`, building);
      addParcel(building.locality, building.parcel, building);
      for (const more of (c[5] || '').split(';').filter(Boolean)) {
        const [l, parcel] = more.split(':');
        addParcel(localities[+l], parcel, building);
      }
    }
  }
  const [province = '', ...rest] = (meta.district || '').split(' ');
  return {version: meta.version || '', province, district: rest.join(' '), byRoad, byParcel};
}

/** A 시·군·구 named in the address that is not this district's: the address is someone else's to look up. */
function otherDistrict(parts, data) {
  const words = data.district.split(' ');
  return parts.prefix.some(t => /(?:시|군|구)$/.test(t) && !/(?:특별시|광역시|특별자치시)$/.test(t) && !words.includes(t));
}

/** {recognizedAddress, convertedAddress, recognizedKind, source} for `query`, or null when this district cannot tell. */
export function lookupLocal(data, query) {
  if (!data) return null;
  const parts = parseParts(extract(query) ?? query);
  if (!parts || parts.number == null || otherDistrict(parts, data)) return null;
  const region = `${data.province} ${data.district}`;
  const road = b => `${region} ${b.road} ${b.number.replace(/^u/, '지하 ')}`;
  const parcel = b => `${region} ${b.locality} ${b.parcel.replace(/^산/, '산 ')}`;
  if (parts.kind === Kind.ROAD) {
    const b = data.byRoad.get(`${parts.name}|${parts.number}`);
    return b ? {recognizedAddress: road(b), convertedAddress: parcel(b), recognizedKind: Kind.ROAD, source: LOCAL_SOURCE} : null;
  }
  const key = `${parts.name}|${parts.mountain ? '산' : ''}${parts.number}`;
  const found = data.byParcel.get(key) || [];
  // One parcel with several road addresses (a large site) is left to the servers, which list them.
  const roads = [...new Set(found.map(road))];
  if (roads.length !== 1) return null;
  const b = found[0];
  return {recognizedAddress: `${region} ${b.locality} ${parts.mountain ? '산 ' : ''}${parts.number}`, convertedAddress: roads[0],
    recognizedKind: Kind.PARCEL, source: LOCAL_SOURCE};
}

/** Text of a gzip file. */
export async function gunzipText(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

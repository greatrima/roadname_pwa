// "순로구분" (대구분): which cell of the sorting rack a converted address goes into, read from the addresses the
// carrier typed for each cell. Same rules as the Android app (core SortingRules.kt), one way of writing for
// everyone: '~' from one number to another, '-' a sub number (127-3). A range may be written backwards (28~2);
// both ends odd keep the odd numbers, both even the even ones, mixed ends everything between. A sub-numbered
// address goes with its main number unless a cell names it. Narrower wins: building unit, sub number, single
// number, range, whole road or 동. Only the cell is decided; the order inside it is the carrier's.
import {extract, parseParts, Kind} from './address-core.mjs';

export const PRIORITY = Object.freeze({ROAD: 'ROAD', PARCEL: 'PARCEL'});
const SUFFIX = '(?:대로|로|번길|길|동|리|가|읍|면)';
const SEPARATORS = /[,，;/·\n]+/;
const NEXT_NAME = new RegExp(`(?<=\\d|번지|번)\\s+(?=[가-힣][가-힣0-9]*?${SUFFIX}\\s*(?:산\\s*)?\\d)`);
const SPACED_ROAD = /([가-힣]+)\s+(\d+\s*(?:번길|길|가))(?=\s|\d|$)/g;
const POINT = new RegExp(`^(?:([가-힣][가-힣0-9]*?${SUFFIX})(?=[\\s\\d산]|$))?\\s*(?:(산)\\s*)?(?:(\\d+)(?:\\s*-\\s*(\\d+))?)?\\s*(?:번지|번(?!길))?\\s*(.*)$`);
const SUB_RANGE = new RegExp(`^(?:([가-힣][가-힣0-9]*?${SUFFIX})(?=[\\s\\d산]|$))?\\s*(?:(산)\\s*)?(\\d+)\\s*-\\s*(\\d+)\\s*~\\s*(?:(\\d+)\\s*-\\s*)?(\\d+)\\s*(?:번지|번)?$`);
const UNIT = /(\d{1,4})\s*동(?![가-힣])/g;
const kindOf = name => (/(?:로|길)$/.test(name) ? Kind.ROAD : Kind.PARCEL);

function entry(fields) {
  return {name: '', kind: Kind.PARCEL, from: null, to: null, sub: null, subTo: null, parity: 'ALL', mountain: false, unit: null, text: '', ...fields};
}
const specificity = e => (e.unit ? 5 : e.sub != null ? 4 : e.from != null && e.from === e.to ? 3 : e.from != null ? 2 : 1);
const width = e => (e.from == null ? Infinity : e.sub != null ? (e.subTo ?? e.sub) - e.sub : e.to - e.from);

function covers(e, main, sub, mountain) {
  if (e.mountain !== mountain) return false;
  if (e.from == null) return true;
  if (main < e.from || main > e.to) return false;
  if (e.sub != null && (sub == null || sub < e.sub || sub > (e.subTo ?? e.sub))) return false;
  return e.parity === 'ALL' || (e.parity === 'ODD' ? main % 2 === 1 : main % 2 === 0);
}

/** "우정1길 1~19 홀수": how an entry is read, shown under the box while typing. */
export function describe(e) {
  let number = '';
  if (e.from != null) {
    const mt = e.mountain ? '산 ' : '';
    if (e.from === e.to) number = ` ${mt}${e.from}${e.sub != null ? `-${e.sub}` : ''}${e.subTo != null ? `~${e.from}-${e.subTo}` : ''}`;
    else number = ` ${mt}${e.from}~${e.to}${e.parity === 'ODD' ? ' 홀수' : e.parity === 'EVEN' ? ' 짝수' : ''}`;
  }
  return `${e.name || '번지'}${number}${e.unit ? ` ${e.unit}` : ''}`.trim();
}

function point(text) {
  const m = POINT.exec(text.trim());
  if (!m) return null;
  return {name: m[1] || '', mountain: !!m[2], main: m[3] ? +m[3] : null, sub: m[4] ? +m[4] : null, rest: (m[5] || '').trim()};
}

function read(text, written, lastName, lastKind) {
  const sub = SUB_RANGE.exec(text);
  if (sub && (!sub[5] || sub[5] === sub[3])) {
    const low = Math.min(+sub[4], +sub[6]), high = Math.max(+sub[4], +sub[6]);
    return entry({name: sub[1] || lastName, kind: sub[1] ? kindOf(sub[1]) : lastKind, from: +sub[3], to: +sub[3], sub: low,
      subTo: high !== low ? high : null, mountain: !!sub[2], text: written});
  }
  const marks = [...text].filter(c => c === '~').length;
  if (marks > 1) return null;
  if (marks === 1) {
    const at = text.indexOf('~');
    const left = point(text.slice(0, at)), right = point(text.slice(at + 1));
    if (!left || !right || left.main == null || right.main == null || left.rest || right.rest) return null;
    const name = left.name || lastName;
    // A span from one road to another follows the route, which the cells do not know.
    if (!name || (right.name && right.name !== name)) return null;
    const low = Math.min(left.main, right.main), high = Math.max(left.main, right.main);
    const parity = low === high ? 'ALL' : low % 2 === 1 && high % 2 === 1 ? 'ODD' : low % 2 === 0 && high % 2 === 0 ? 'EVEN' : 'ALL';
    return entry({name, kind: left.name ? kindOf(left.name) : lastKind, from: low, to: high, parity, mountain: left.mountain, text: written});
  }
  const single = point(text);
  if (!single || /[~=-]/.test(single.rest) || (!single.name && single.main == null)) return null;
  const name = single.name || (single.main != null ? lastName : '');
  const kind = single.name ? kindOf(single.name) : lastKind;
  if (single.main == null) return entry({name, kind, text: written});
  const unit = [...single.rest.matchAll(UNIT)][0];
  return entry({name, kind, from: single.main, to: single.main, sub: single.sub, mountain: single.mountain, unit: unit ? `${unit[1]}동` : null, text: written});
}

/** A cell's addresses read into entries; `problems` are the pieces that could not be read. */
export function parseLabel(text) {
  const entries = [], problems = [];
  let lastName = '', lastKind = Kind.PARCEL;
  const pieces = String(text || '').replace(/[∼～〜]/g, '~').split(SEPARATORS).flatMap(p => p.trim().split(NEXT_NAME));
  for (const raw of pieces) {
    const written = raw.trim();
    if (!written) continue;
    const joined = written.replace(SPACED_ROAD, '$1$2').replace(/\s+/g, ' ');
    const e = read(joined, written, lastName, lastKind);
    if (!e) { problems.push(written); continue; }
    entries.push(e);
    if (e.name) { lastName = e.name; lastKind = e.kind; }
  }
  return {entries, problems};
}

/** A converted address reduced to what the cells speak of; null without a number. */
export function sortingAddress(text, kind) {
  if (!text) return null;
  const parts = parseParts(extract(text) ?? text);
  if (!parts || parts.kind !== kind || parts.number == null) return null;
  const [main, sub] = parts.number.split('-');
  return {kind, name: parts.name.replace(/\s/g, ''), main: +main, sub: sub != null && sub !== '' ? +sub : null, mountain: parts.mountain};
}

const units = source => new Set([...String(source || '').matchAll(UNIT)].map(m => `${m[1]}동`));

function matches(e, address, unitSet) {
  if (e.kind !== address.kind) return false;
  if (e.name && e.name.replace(/\s/g, '') !== address.name) return false;
  if (!e.name && e.from == null) return false;
  if (e.unit && !unitSet.has(e.unit)) return false;
  return covers(e, address.main, address.sub, address.mountain);
}

function overlap(a, b) {
  if (a.kind !== b.kind || a.name !== b.name || a.mountain !== b.mountain || a.unit !== b.unit) return false;
  if (a.from == null || b.from == null) return a.from == null && b.from == null;
  if (a.sub != null && b.sub != null && Math.max(a.sub, b.sub) > Math.min(a.subTo ?? a.sub, b.subTo ?? b.sub)) return false;
  const low = Math.max(a.from, b.from), high = Math.min(a.to, b.to);
  const sub = a.sub != null && b.sub != null ? Math.max(a.sub, b.sub) : a.sub ?? b.sub;
  for (let n = low; n <= high; n++) if (covers(a, n, sub, a.mountain) && covers(b, n, sub, b.mountain)) return true;
  return false;
}

export const cellCount = rack => (rack?.columns || 0) * (rack?.rows || 0);
export const configured = rack => cellCount(rack) > 0;
const labelled = rack => Object.entries(rack.labels || {}).filter(([cell, text]) => +cell >= 1 && +cell <= cellCount(rack) && String(text).trim());

/**
 * The cell for the converted address in both forms; `source` is the text read from the mail, for a building unit
 * ("104동") the address itself does not carry. {cell, outside} | {state: 'notMine' | 'unassigned' | 'notConfigured'}.
 */
// ---- "아파트 묶기": a complex with its main and shops' addresses; labels name it with its 동 ("우정아파트 101,102") ----
const SHOPS = '상가';
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const apartmentAddresses = a => [a.main, ...String(a.shops || '').split(/[,，]/)].map(s => String(s || '').trim()).filter(Boolean);

/** {apartments, rest}: the apartment pieces of a label and the label without them (as the app's SortingApartments). */
export function extractApartments(text, names) {
  const apartments = [];
  let rest = String(text || '');
  for (const name of [...(names || [])].filter(n => String(n).trim()).sort((a, b) => b.length - a.length)) {
    // The name stands alone (not inside "우정1길" for a complex named "우정"); its 동 or 상가 follow, with commas.
    const piece = new RegExp(`(?<![가-힣])${escape(name)}((?:\\s*[,，]?\\s*(?:${SHOPS}|\\d{1,4}\\s*동?)(?![\\d가-힣~-]))*)(?![\\d가-힣])`, 'g');
    rest = rest.replace(piece, (whole, tail) => {
      const unitList = [...new Set([...tail.matchAll(/\d{1,4}/g)].map(m => `${+m[0]}동`))];
      apartments.push({name, units: unitList, shops: tail.includes(SHOPS) && !unitList.length, text: whole.trim()});
      return ',';
    });
  }
  return {apartments, rest};
}

export function describeApartment(a) {
  if (a.shops) return `${a.name} 상가`;
  if (!a.units.length) return `${a.name} 전체`;
  return `${a.name} ${[...a.units].sort((x, y) => parseInt(x) - parseInt(y)).join('·')}`;
}

/** The label read with the rack's apartments: {entries, problems, apartments}. */
export function parseRackLabel(text, rack) {
  const {apartments, rest} = extractApartments(text, (rack?.apartments || []).map(a => a.name));
  return {...parseLabel(rest), apartments};
}

function apartmentCell(rack, forms, unitSet) {
  const apartment = (rack.apartments || []).find(a => apartmentAddresses(a).some(address =>
    parseLabel(address).entries.some(e => e.from != null && forms.some(form => matches(e, form, new Set())))));
  if (!apartment) return null;
  const mine = labelled(rack).flatMap(([cell, text]) => parseRackLabel(text, rack).apartments.filter(a => a.name === apartment.name).map(a => [+cell, a]));
  if (!mine.length) return null;
  const unit = [...unitSet][0] || null;
  const narrow = unitSet.size ? mine.find(([, a]) => a.units.some(u => unitSet.has(u))) : mine.find(([, a]) => a.shops);
  const whole = mine.find(([, a]) => !a.units.length && !a.shops);
  const hit = narrow || whole;
  return hit ? {cell: hit[0], outside: false, apartment: apartment.name, unit} : {state: 'unassigned'};
}

export function locate(rack, road, parcel, source = '') {
  if (!configured(rack)) return {state: 'notConfigured'};
  const parsed = labelled(rack).map(([cell, text]) => [+cell, parseRackLabel(text, rack).entries]);
  const roadFirst = (rack.priority || PRIORITY.ROAD) === PRIORITY.ROAD;
  const forms = [sortingAddress(road, Kind.ROAD), sortingAddress(parcel, Kind.PARCEL)].filter(Boolean)
    .sort((a, b) => ((a.kind === Kind.ROAD) === roadFirst ? 0 : 1) - ((b.kind === Kind.ROAD) === roadFirst ? 0 : 1));
  const unitSet = units(source);
  // An address of an apartment named on the labels goes by its 동 (shops' addresses too: residents use them).
  const byApartment = apartmentCell(rack, forms, unitSet);
  if (byApartment) return byApartment;
  for (const form of forms) {
    let best = null;
    for (const [cell, entries] of parsed) {
      for (const e of entries) {
        if (!matches(e, form, unitSet)) continue;
        if (!best || specificity(e) > specificity(best.e) || (specificity(e) === specificity(best.e) && width(e) < width(best.e))) best = {cell, e};
      }
    }
    if (best) return {cell: best.cell, outside: false};
  }
  if (parsed.every(([, entries]) => !entries.length)) return {state: 'unassigned'};
  // Within the numbers named for a road or 동 the round has a gap; beyond them it is someone else's.
  const inside = forms.some(form => {
    const named = parsed.flatMap(([, entries]) => entries).filter(e => e.kind === form.kind && e.name === form.name && e.from != null);
    return named.length && form.main >= Math.min(...named.map(e => e.from)) && form.main <= Math.max(...named.map(e => e.to));
  });
  if (inside) return {state: 'unassigned'};
  const outside = +rack.outside;
  return outside >= 1 && outside <= cellCount(rack) ? {cell: outside, outside: true} : {state: 'notMine'};
}

/** Other cells naming an address of `text` (written for `cell`) just as narrowly; a narrower exception is no overlap. */
export function overlaps(rack, cell, text) {
  const mine = parseLabel(text).entries;
  return labelled(rack).filter(([other]) => +other !== cell).filter(([, label]) => {
    const theirs = parseLabel(label).entries;
    return mine.some(a => theirs.some(b => overlap(a, b) && specificity(a) === specificity(b) && width(a) === width(b)));
  }).map(([other]) => +other).sort((a, b) => a - b);
}

/** "누정4길 50" / "누정동 12-3": what 칸 지정 adds to a cell for `address`. */
export function piece(address) {
  const parts = parseParts(extract(address) ?? address);
  if (!parts || parts.number == null) return null;
  return `${parts.name} ${parts.mountain ? '산 ' : ''}${parts.number}`;
}

export const filledCount = rack => labelled(rack).length;
export const summary = rack => `${rack.columns}×${rack.rows} · ${filledCount(rack)}칸`;

// ---- 내보내기 / 불러오기: plain text, kept anywhere (메모, 카톡) and read back by the app and the web alike ----
const HEADER = '도로명변환기 구분대';

export function exportText(rack) {
  const lines = [`${HEADER} · ${rack.name || '구분대'} · ${rack.columns}×${rack.rows}`,
    `주소 기준: ${rack.priority === PRIORITY.PARCEL ? '지번 우선' : '도로명 우선'}`,
    `구역 밖 칸: ${rack.outside ? rack.outside : '없음'}`];
  for (const a of rack.apartments || []) lines.push(`아파트: ${a.name} | ${a.main || ''} | ${a.shops || ''}`.replace(/[\s|]+$/, ''));
  for (const [cell, text] of labelled(rack).sort((a, b) => +a[0] - +b[0])) lines.push(`${cell}: ${String(text).replace(/,?\s*\n\s*/g, ', ').trim()}`);
  return lines.join('\n');
}

/** {rack, problems} from exported text (any later format keeps reading this one); null when it is no rack. */
export function importText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const head = lines.findIndex(l => l.startsWith(HEADER));
  if (head < 0) return null;
  const m = /^도로명변환기 구분대(?:\s*·\s*(.+?))?\s*·\s*(\d+)\s*[×xX*]\s*(\d+)$/.exec(lines[head]);
  if (!m) return null;
  const rack = {name: (m[1] || '구분대').trim(), columns: +m[2], rows: +m[3], labels: {}, priority: PRIORITY.ROAD, outside: null, apartments: []};
  if (!configured(rack) || rack.columns > 12 || rack.rows > 12) return null;
  const problems = [];
  for (const line of lines.slice(head + 1)) {
    let c;
    if ((c = /^아파트\s*:\s*(.+)$/.exec(line))) {
      const [name, main = '', shops = ''] = c[1].split('|').map(s => s.trim());
      if (name) rack.apartments.push({name, main, shops});
    } else if ((c = /^주소 기준\s*:\s*(.+)$/.exec(line))) rack.priority = c[1].includes('지번') ? PRIORITY.PARCEL : PRIORITY.ROAD;
    else if ((c = /^구역 밖 칸\s*:\s*(\d+)?/.exec(line))) rack.outside = c[1] && +c[1] <= cellCount(rack) ? +c[1] : null;
    else if ((c = /^(\d+)\s*[:：]\s*(.+)$/.exec(line)) && +c[1] >= 1 && +c[1] <= cellCount(rack)) rack.labels[+c[1]] = c[2].trim();
    else problems.push(line);
  }
  return {rack, problems};
}

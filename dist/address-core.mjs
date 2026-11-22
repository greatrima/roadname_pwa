// Address structure logic ported from the Android app (greatrima/roadnameconverter v2.0.1):
// AddressTextParser, AddressMatchValidator, AddressDetails, RawAddressCandidates,
// OcrLineAssembler, CandidateTracker.identity and the first-frame AutoConversionPolicy gate.
// Structure only: no spelling correction, no invented numbers, OCR source is never rewritten.

export const Kind = Object.freeze({PARCEL: 'PARCEL', ROAD: 'ROAD', UNKNOWN: 'UNKNOWN'});
export const COMPLETE = 'COMPLETE';
export const PARTIAL = 'PARTIAL';

export function candidate(text, kind, extra = {}) {
  return {text, kind, completeness: COMPLETE, confidence: 100, dictionaryCorrected: false, verified: false,
    details: '', manualOnly: false, alternativeTarget: '', reviewReason: '', ...extra};
}

const PROVINCE_SUFFIX = '(?:특별자치도|특별자치시|광역시|특별시|도)';
const DISTRICT_SUFFIX = '(?:시|군|구)';
const LOCALITY_SUFFIX = '(?:읍|면|동|가|리)';
const ROAD_SUFFIX = '(?:대로|로|길)';
const NUMBER = '\\d{1,5}(?:\\s*-\\s*\\d{1,5})?';
const PREFIX = `(?:[가-힣0-9]+(?:${PROVINCE_SUFFIX}|${DISTRICT_SUFFIX}|읍|면)\\s+)*`;
const NO_TAIL = '(?!\\d|\\s*(?:-|동|층|호))';
// A base number is never followed by the rest of a numbered road/legal-dong name ('헤움로 12길', '결수대로 123번길',
// '울지로3가'): otherwise '헤움로 12길 34' would be cut to the different real address '헤움로 12' (as on Android).
const NUMBER_END = '(?!\\d|\\s*(?:-|동|층|호)|\\s*번?길(?![가-힣])|\\s*가(?![가-힣]))';

const parcelSource = `${PREFIX}([가-힣][가-힣0-9]*${LOCALITY_SUFFIX})\\s*(산\\s*)?(${NUMBER})(?:\\s*번지)?${NUMBER_END}`;
const roadSource = `${PREFIX}([가-힣0-9]+${ROAD_SUFFIX})\\s*(${NUMBER})${NUMBER_END}`;
const parcelAddress = new RegExp(parcelSource);
const roadAddress = new RegExp(roadSource);
const parcelAll = () => new RegExp(parcelSource, 'g');
const roadAll = () => new RegExp(roadSource, 'g');
const addressNameOnly = new RegExp(`^(?:[가-힣0-9]+(?:${PROVINCE_SUFFIX}|${DISTRICT_SUFFIX}|읍|면)\\s+)*` +
  `(?:[가-힣][가-힣0-9]*${LOCALITY_SUFFIX}|[가-힣0-9]+${ROAD_SUFFIX})$`);
const numberOnly = /^(?:산\s*)?\d{1,5}(?:\s*-\s*\d{1,5})?(?:\s*번지)?$/;
const subNumberOnly = /^-\s*\d{1,5}$/;
const phoneSource = '(?:01[016789]|0\\d{1,2})[- ]?\\d{3,4}[- ]?\\d{4}';
const phoneLike = new RegExp(phoneSource);
const phoneWhole = new RegExp(`^${phoneSource}$`);
const nonAddressLabel = /^(?:성명|이름|전화|휴대폰|연락처|TEL|FAX|우편번호|우편|ZIP|부서|부서명|배송\s*메모|배송\s*요청사항)(?:(?:\s*[:：]\s*|\s+).*|$)/i;
const DASHES = /[‐‑‒–—−﹣－]/g;
const lineSplit = text => text.split(/\r\n|\n|\r/);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (text, char) => [...text].filter(c => c === char).length;
const distinctBy = (items, key) => {
  const seen = new Set();
  return items.filter(item => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- AddressMatchValidator.normalizeRegions ----
const provinceAliases = new Map([['서울', '서울특별시'], ['부산', '부산광역시'], ['대구', '대구광역시'], ['인천', '인천광역시'],
  ['광주', '광주광역시'], ['대전', '대전광역시'], ['울산', '울산광역시'], ['세종', '세종특별자치시'], ['경기', '경기도'],
  ['강원', '강원특별자치도'], ['강원도', '강원특별자치도'], ['충북', '충청북도'], ['충남', '충청남도'], ['전북', '전북특별자치도'],
  ['전라북도', '전북특별자치도'], ['전남', '전라남도'], ['경북', '경상북도'], ['경남', '경상남도'], ['제주', '제주특별자치도'],
  ['제주도', '제주특별자치도']]);
const aliasTokens = new RegExp(`(^|\\s)(${[...provinceAliases.keys()].map(escape).join('|')})(?=\\s|$)`, 'g');
const canonicalRegion = value => provinceAliases.get(value) || value;
export const normalizeRegions = text => text.replace(aliasTokens, (_, before, token) => before + canonicalRegion(token));

// ---- AddressTextParser ----
// OCR/typing often separates a numbered road or '로N가' legal dong from its base name ('헤움로 12 길 34').
const joinSpacedNames = text => text
  .replace(/([가-힣](?:대로|로))[ \t]+(\d{1,4})[ \t]*(번길|길)(?![가-힣])/g, '$1$2$3')
  .replace(/([가-힣]로)[ \t]+(\d{1,2})[ \t]*가(?=[ \t]*(?:산[ \t]*)?\d)/g, '$1$2가');

function normalizeOcrText(raw) {
  return joinSpacedNames(normalizeRegions(raw)
    .replace(DASHES, '-')
    .replace(/(지번|도로명)?\s*주소\s*[:：]?/gi, ' ')
    .replace(/[|,_·•]/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')'));
}

function format(value) {
  return joinSpacedNames(value
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' '))
    .replace(/(읍|면|동|가|리)(?=(?:산)?\d)/g, '$1 ')
    .replace(/산(?=\d)/g, '산 ')
    .replace(/\s*번지$/, '')
    .trim();
}

// ---- AddressLabels ----
// Postal-slip labels ('받는분', '수취인', '보내는 사람') printed vertically are read one letter glued to each address
// line ('받서울특별시', '는집배로 2길 18', '분101동'), glued to a number ('받우정동123-4'), on its own ('받 우정동 5')
// or in front of the rest of a road split over two lines ('집배동로\n는228길'). A label is taken off only when the
// word is no real name and what remains is one (or a unit such as '101동'), so a real name ('인천', '송파') stays.
const LABEL_WORDS = [
  '보내는사람', '받는사람', '받으시는분', '보내시는분', '보내는분', '받는분', '보내는곳', '받는곳', '보내는이', '받는이',
  '수취인', '수신인', '수신자', '발송인', '발신인', '보낸사람', '보내는', '받는', '받으시는',
];
/** The labels and every piece a vertical print splits them into, longest first. */
const LABELS = [...new Set(LABEL_WORDS.flatMap(label => {
  const pieces = [];
  for (let n = 1; n <= label.length; n++) for (let i = 0; i + n <= label.length; i++) pieces.push(label.slice(i, i + n));
  return pieces;
}))].sort((a, b) => b.length - a.length);
/** Any letter a slip label is made of: the cheap gate before the dictionary is asked. */
export const LABEL_LETTER = new RegExp(`[${[...new Set(LABEL_WORDS.join(''))].join('')}]`);
const UNIT = /^\d{1,5}(?:동|층|호)$/;
const ROAD_REST = /^\d{1,4}(?:번길|길)$/;
const ROAD_END = /^[가-힣0-9]*[가-힣](?:대로|로)$/;
const HANGUL_HEAD = /^[가-힣]+(?=\d)/;
/** `text` with leading labels taken off its words, or `text` itself when none was; `isRealName` is an exact lookup. */
export function stripAddressLabels(text, isRealName) {
  if (!LABELS.some(label => text.includes(label))) return text;
  const known = rest => UNIT.test(rest) || isRealName(rest) || isRealName(normalizeRegions(rest));
  // The line before ends with a road name that, with `rest` ('228길'), is one road.
  const continuesRoad = (before, rest) => {
    const last = /([가-힣0-9]+)\s*$/.exec(before.trimEnd())?.[1];
    return !!last && ROAD_END.test(last) && (isRealName(last + rest) || isRealName(last));
  };
  const remains = (rest, before) => known(rest) || (HANGUL_HEAD.test(rest) && known(HANGUL_HEAD.exec(rest)[0])) ||
    (ROAD_REST.test(rest) && continuesRoad(before, rest));
  const realHead = word => HANGUL_HEAD.test(word) && isRealName(HANGUL_HEAD.exec(word)[0]);
  const joined = joinSpacedNames(text);
  const glued = joined.replace(/[가-힣][가-힣0-9]*/g, (word, offset) => {
    if (isRealName(word) || realHead(word)) return word;
    const before = joined.slice(0, offset);
    const label = LABELS.find(l => word.length > l.length && word.startsWith(l) && remains(word.slice(l.length), before));
    return label ? word.slice(label.length) : word;
  });
  // A label letter or two read on its own at the start of a line, before a real name: '받 우정동 5'.
  const lines = glued.split('\n');
  const result = lines.map((line, index) => {
    const trimmed = line.trimStart();
    const space = trimmed.indexOf(' ');
    if (space < 0) return line;
    const first = trimmed.slice(0, space), after = trimmed.slice(space).trimStart(), next = after.split(' ')[0];
    const lone = first.length <= 2 && !LABEL_WORDS.includes(first) && LABELS.includes(first) && !isRealName(first);
    const before = lines.slice(0, index).join('\n');
    const follows = !!next && (known(HANGUL_HEAD.exec(next)?.[0] ?? next) || (ROAD_REST.test(next) && continuesRoad(before, next)));
    return lone && follows ? after : line;
  }).join('\n');
  return result === joined ? text : result;
}

export const normalizeKey = address => address.replace(DASHES, '-').replace(/\s+/g, '').toLowerCase();

export function isNonAddressLine(text) {
  const trimmed = text.trim();
  return nonAddressLabel.test(trimmed) || phoneWhole.test(trimmed) || /^\(?우\)?\s*[:：]?\s*\d{5}$/.test(trimmed);
}

export function startsWithBaseNumber(text) {
  const normalized = normalizeOcrText(text).trim();
  if (isNonAddressLine(text)) return false;
  const lead = new RegExp(`^(?:산\\s*)?${NUMBER}(?:\\s*번지)?${NO_TAIL}(?=\\s|[,.(]|$)`).exec(normalized);
  if (!lead) return false;
  // Web change from Android: a phone number later on the line ("12, 205호 (모잔동) 031-123-4567") does not
  // disqualify the base number; one that starts at the leading number ("031 123 4567") still does.
  const phone = phoneLike.exec(normalized);
  return !phone || phone.index >= lead[0].length;
}

const cleanLines = block => lineSplit(block).map(line => line.replace(/\s+/g, ' ').trim())
  .filter(line => line && !isNonAddressLine(line));

const splitBlocks = text => lineSplit(text).map(line => (isNonAddressLine(line) ? '\n' : line)).join('\n')
  .split(/\n\s*\n+/);

function prefixTokens(value, name) {
  const index = value.indexOf(name);
  return (index < 0 ? value : value.slice(0, index)).trim().split(/\s+/).filter(Boolean);
}

export function parseParts(address) {
  const formatted = format(address);
  const road = roadAddress.exec(formatted);
  if (road && normalizeKey(road[0]) === normalizeKey(formatted)) {
    return {prefix: prefixTokens(road[0], road[1]), name: road[1], number: road[2].replace(/\s+/g, ''), kind: Kind.ROAD, mountain: false};
  }
  const parcel = parcelAddress.exec(formatted);
  if (parcel && normalizeKey(parcel[0]) === normalizeKey(formatted)) {
    return {prefix: prefixTokens(parcel[0], parcel[1]), name: parcel[1], number: parcel[3].replace(/\s+/g, ''),
      kind: Kind.PARCEL, mountain: !!(parcel[2] && parcel[2].trim())};
  }
  if (addressNameOnly.test(formatted)) {
    const tokens = formatted.split(/\s+/);
    const name = tokens[tokens.length - 1];
    const kind = /(?:대로|로|길)$/.test(name) ? Kind.ROAD : Kind.PARCEL;
    return {prefix: tokens.slice(0, -1), name, number: null, kind, mountain: false};
  }
  return null;
}

export const classify = address => parseParts(address)?.kind || Kind.UNKNOWN;

export function repairRoadAcrossSamples(left, right) {
  const normalizedLeft = normalizeOcrText(left).trim();
  const leftMatch = new RegExp(`^(?:(?:[가-힣0-9]+(?:${PROVINCE_SUFFIX}|${DISTRICT_SUFFIX}|읍|면))\\s+)*([가-힣][가-힣0-9]{0,24})$`)
    .exec(normalizedLeft);
  if (!leftMatch) return null;
  if (new RegExp(`(?:${PROVINCE_SUFFIX}|${DISTRICT_SUFFIX}|${LOCALITY_SUFFIX}|${ROAD_SUFFIX})$`).test(leftMatch[1])) return null;
  const continuation = new RegExp(`^([가-힣0-9]{0,4}(?:대로|로|길))\\s*(${NUMBER})${NO_TAIL}(?=\\s|\\(|,|$)`).exec(right);
  if (!continuation) return null;
  // A complete-looking road word is not a continuation; split pieces look like '동로' or '로12길'.
  const fragment = continuation[1];
  if (fragment.length > 4 && !fragment.startsWith('로')) return null;
  return `${normalizedLeft}${fragment} ${continuation[2]}` + right.slice(continuation.index + continuation[0].length);
}

export function repairNumberAcrossSamples(left, right) {
  const before = normalizeOcrText(left).trimEnd();
  const after = normalizeOcrText(right).trimStart();
  if (!before.endsWith('-') || !startsWithBaseNumber(after) || after.startsWith('산')) return null;
  const base = parseParts(before.slice(0, -1));
  if (!base || base.number == null || base.number.includes('-')) return null;
  return before + after;
}

function shouldJoinWithoutSpace(previous, next) {
  const openParentheses = count(previous, '(') > count(previous, ')');
  const roadContinuation = repairRoadAcrossSamples(previous, next) != null;
  const detailNumberContinuation = /^.*(?:\d+\s*(?:동|층)|지하)\s*\d{1,2}$/.test(previous) && /^\d{2,4}호.*$/.test(next);
  const lastToken = previous.slice(previous.lastIndexOf(' ') + 1);
  const administrativeContinuation = /[가-힣]$/.test(previous) && /^(?:도|시|군|구|읍|면|동|리)(?:\s+|\d).*$/.test(next) &&
    !new RegExp(`(?:${PROVINCE_SUFFIX}|${DISTRICT_SUFFIX}|${LOCALITY_SUFFIX}|${ROAD_SUFFIX})$`).test(lastToken);
  return roadContinuation || administrativeContinuation || detailNumberContinuation ||
    (openParentheses && /[가-힣]$/.test(previous) && /^[가-힣]/.test(next));
}

/** Reconstructs only strong same-block line continuations; the untouched OCR source stays separate. */
export function restoreStructuredText(rawText) {
  return splitBlocks(normalizeOcrText(rawText)).map(block => {
    const lines = cleanLines(block);
    if (!lines.length) return '';
    const restored = [lines[0]];
    for (const line of lines.slice(1)) {
      const previous = restored[restored.length - 1];
      const numberRepair = repairNumberAcrossSamples(previous, line);
      if (numberRepair != null) restored[restored.length - 1] = numberRepair;
      else if (shouldJoinWithoutSpace(previous, line)) restored[restored.length - 1] = previous + line;
      else restored.push(line);
    }
    return restored.join('\n');
  }).join('\n\n');
}

function addAdjacentLineRepairs(lines, variants) {
  for (let i = 0; i < lines.length - 1; i++) {
    const first = lines[i], second = lines[i + 1];
    variants.add(`${first} ${second}`);
    if (addressNameOnly.test(first) && (numberOnly.test(second) || subNumberOnly.test(second))) {
      variants.add(first + (subNumberOnly.test(second) ? second : ` ${second}`));
    }
    const road = repairRoadAcrossSamples(first, second);
    if (road != null) variants.add(road);
    const number = repairNumberAcrossSamples(first, second);
    if (number != null) variants.add(number);
  }
}

function rankedCandidates(texts, includePartial) {
  const found = [];
  for (const text of texts) {
    for (const match of text.matchAll(parcelAll())) found.push(candidate(format(match[0]), Kind.PARCEL));
    for (const match of text.matchAll(roadAll())) {
      const number = match[2];
      found.push(candidate(format(match[0].slice(0, match[0].length - number.length).trimEnd() + ' ' + number), Kind.ROAD));
    }
  }
  const complete = distinctBy(found.filter(c => !phoneLike.test(c.text)), c => normalizeKey(c.text));
  const filtered = complete.filter(c => {
    const key = normalizeKey(c.text);
    return !complete.some(other => {
      if (other === c || other.kind !== c.kind) return false;
      const otherKey = normalizeKey(other.text);
      return otherKey.length > key.length && (otherKey.startsWith(key) || otherKey.endsWith(key));
    });
  });
  if (includePartial) {
    for (const raw of texts) {
      const text = raw.trim();
      if (!addressNameOnly.test(text)) continue;
      const parts = parseParts(text);
      if (!parts) continue;
      if (!filtered.some(f => normalizeKey(f.text).startsWith(normalizeKey(text)))) {
        filtered.push(candidate(format(text), parts.kind, {completeness: PARTIAL, confidence: 55}));
      }
    }
  }
  return distinctBy(filtered, c => normalizeKey(c.text)).sort((a, b) =>
    ((b.completeness === COMPLETE) - (a.completeness === COMPLETE)) || (b.text.length - a.text.length) || compareText(a.text, b.text));
}

export function extractCandidates(rawText, includePartial = false) {
  if (!rawText || !rawText.trim()) return [];
  const normalized = normalizeOcrText(rawText);
  const variants = new Set();
  for (const block of splitBlocks(normalized)) {
    const lines = cleanLines(block);
    variants.add(restoreStructuredText(block).replace(/\n/g, ' '));
    for (const line of lines) variants.add(line);
    variants.add(lines.join(' '));
    addAdjacentLineRepairs(lines, variants);
  }
  return rankedCandidates(variants, includePartial).map(c => ({...c, details: extractDetails(rawText, c.text)}));
}

export const extractCandidate = rawText => extractCandidates(rawText).find(c => c.completeness === COMPLETE) || null;
export const extract = rawText => extractCandidate(rawText)?.text ?? null;

// ---- AddressDetails: details never enter the API query ----
const unitPattern = () => /(?:지하\s*)?\d+(?:-\d+)?\s*(?:동|층|호)(?![가-힣])/g;
const buildingPattern = () => /[가-힣A-Za-z0-9]*(?:아파트|빌라|오피스텔|타운|푸르지오|래미안|자이|힐스테이트|주택|빌딩|회관|센터)/g;

export function extractDetails(raw, base) {
  const parsed = parseParts(base);
  if (!parsed || parsed.number == null) return '';
  const flattened = restoreStructuredText(raw).replace(/\n/g, ' ');
  const number = parsed.number.split('-').map(escape).join('\\s*-\\s*');
  const matched = new RegExp(`${escape(parsed.name)}\\s*(?:산\\s*)?${number}(?:\\s*번지)?`).exec(flattened);
  if (!matched) return '';
  const tail = flattened.slice(matched.index + matched[0].length);
  const heading = flattened.slice(0, matched.index);
  const buildings = [...`${heading} ${tail}`.matchAll(buildingPattern())].map(m => m[0]).slice(0, 3);
  const units = [...tail.matchAll(unitPattern())].map(m => m[0].replace(/\s+/g, '')).slice(0, 4);
  return [...new Set([...buildings, ...units])].join(' ');
}

// ---- AddressMatchValidator: no fuzzy matching at the API boundary ----
export const validatedParts = text => {
  const base = extract(normalizeRegions(text));
  return base == null ? null : parseParts(base);
};

const numberKey = value => value.split('-').map(part => (/^\d+$/.test(part.trim()) ? Number(part.trim()) : null));

export function exactMatch(query, returnedAddress) {
  const wanted = validatedParts(query), actual = validatedParts(returnedAddress);
  if (!wanted || !actual) return false;
  if (wanted.kind !== actual.kind || wanted.name !== actual.name || wanted.mountain !== actual.mountain ||
    wanted.number == null || actual.number == null) return false;
  const a = numberKey(wanted.number), b = numberKey(actual.number);
  if (a.length !== b.length || a.some((value, i) => value !== b[i])) return false;
  // Every supplied region must occur in order. Omitted upper levels may be supplied by the API.
  let position = 0;
  const actualPath = actual.prefix.map(canonicalRegion);
  for (const token of wanted.prefix.map(canonicalRegion)) {
    let index = -1;
    for (let i = position; i < actualPath.length; i++) if (actualPath[i] === token) { index = i; break; }
    if (index < 0) return false;
    position = index + 1;
  }
  return true;
}

/** Only explicitly returned parcel numbers are related parcels; never infer one from a road. */
export function relatedParcels(primary, landNumbers) {
  const parts = validatedParts(primary);
  if (!parts || parts.kind !== Kind.PARCEL) return [];
  if (!/^(?:산\s*)?\d+(?:-\d+)?(?:\s*[,;]\s*(?:산\s*)?\d+(?:-\d+)?)*$/.test(landNumbers)) return [];
  const prefix = [...parts.prefix, parts.name].join(' ');
  return landNumbers.split(/[,;]/).filter(n => !parts.mountain || n.trim().startsWith('산')).map(n => `${prefix} ${n.trim()}`);
}

// ---- CandidateTracker.identity ----
export function identity(c) {
  const parts = parseParts(c.text);
  if (!parts) return normalizeKey(c.text);
  return [parts.prefix.map(normalizeKey).join('/'), parts.kind, normalizeKey(parts.name), String(parts.mountain),
    parts.number || '', normalizeKey(c.details || ''), normalizeKey(c.alternativeTarget || '')].join(':');
}

// ---- RawAddressCandidates: fast structure-only path ----
const isProvinceToken = token => /(?:도|특별시|광역시|특별자치시)$/.test(token);

export function parseRegion(value) {
  const [province = '', district = ''] = String(value || '').split('|');
  return {province, district};
}
export const regionName = region => [region.province, region.district].filter(Boolean).join(' ');

export function withDefaultRegion(c, region) {
  if (!region || (!region.province && !region.district)) return c;
  const parts = parseParts(c.text);
  if (!parts) return c;
  const configured = normalizeRegions(regionName(region)).split(' ').filter(Boolean);
  const explicit = parts.prefix;
  const explicitProvince = explicit.find(isProvinceToken);
  if (explicitProvince != null && explicitProvince !== configured[0]) return c;
  const districts = explicit.filter(t => !isProvinceToken(t) && /(?:시|군|구)$/.test(t));
  // Only supplement a compatible path; never attach the selected province to an unrelated city.
  let position = 0;
  for (const district of districts) {
    let index = -1;
    for (let i = position; i < configured.length; i++) if (configured[i] === district) { index = i; break; }
    if (index < 0) return c;
    position = index + 1;
  }
  const prefix = [...configured, ...explicit.filter(t => !configured.includes(t))].join(' ');
  const number = parts.number != null ? ` ${parts.mountain ? '산 ' : ''}${parts.number}` : '';
  return {...c, text: `${prefix} ${parts.name}${number}`.trim()};
}

const POSTAL_REVIEW = '우편번호/번지 확인 필요';

export function candidatesFromBlocks(blocks, region) {
  const list = blocks.flatMap(block => extractCandidates(block, true).map(c => {
    const number = parseParts(c.text)?.number;
    // A five-digit number on its own line may be a postal code. Keep it, but ask for confirmation.
    if (number != null && /^\d{5}$/.test(number) && lineSplit(block).some(line => line.trim() === number)) {
      return {...c, manualOnly: true, reviewReason: POSTAL_REVIEW};
    }
    return c;
  })).map(c => withDefaultRegion(c, region));
  return distinctBy(list, identity).slice(0, 5);
}

export function candidatesFromSpatialBlocks(blocks, region) {
  const list = blocks.flatMap(block => candidatesFromBlocks([block.text], region).map(c => ({...c,
    manualOnly: c.manualOnly || !!block.requiresConfirmation,
    reviewReason: block.requiresConfirmation ? POSTAL_REVIEW : c.reviewReason})));
  return distinctBy(list, identity).slice(0, 5);
}

/** First-frame AutoConversionPolicy gate: exactly one complete, observed (not dictionary) address. */
export function automaticCandidate(candidates) {
  const complete = distinctBy(candidates.filter(c => !c.manualOnly && !c.dictionaryCorrected &&
    c.completeness === COMPLETE && parseParts(c.text)?.number != null), identity);
  return complete.length === 1 ? complete[0] : null;
}

// ---- OcrLineAssembler: spatial/structural grouping only ----
const boxWidth = b => b.right - b.left;
const boxHeight = b => b.bottom - b.top;
const bounds = lines => ({left: Math.min(...lines.map(l => l.box.left)), top: Math.min(...lines.map(l => l.box.top)),
  right: Math.max(...lines.map(l => l.box.right)), bottom: Math.max(...lines.map(l => l.box.bottom))});
const detailLine = /^(?:(?:[,.( ]|지하|\d+\s*(?:동|층|호)|-\s*\d).*|.*(?:아파트|빌라|오피스텔|타운|푸르지오|래미안|힐스테이트).*)$/;
const record = (trace, text) => { if (trace && trace.length < 100) trace.push(text); };
const boxText = b => `(${Math.round(b.left)},${Math.round(b.top)})-(${Math.round(b.right)},${Math.round(b.bottom)})`;

function canJoin(previous, next, context) {
  const a = previous.box, b = next.box;
  const size = Math.max(boxHeight(a), boxHeight(b), 1);
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const minHeight = Math.min(boxHeight(a), boxHeight(b));
  const sameRow = Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) < minHeight * 0.55;
  if (sameRow) {
    if (b.left < a.right || b.left - a.right > size * 1.3) return {allowed: false, reason: '가로 거리/겹침'};
  } else {
    if (b.top < a.bottom - minHeight * 0.25 || b.top - a.bottom > size * 1.65) return {allowed: false, reason: '세로 거리/읽기 순서'};
    if (Math.abs(a.left - b.left) > size * 1.2 && overlap < Math.min(boxWidth(a), boxWidth(b)) * 0.65) {
      return {allowed: false, reason: '다른 열/가로 겹침 부족'};
    }
  }
  const first = extract(context), second = extract(next.text);
  if (first != null && second != null) return {allowed: false, reason: '독립된 완성 주소 2개'};
  if (repairRoadAcrossSamples(previous.text, next.text) != null) return {allowed: true, reason: '관측된 도로명 조각/접미사'};
  if (repairNumberAcrossSamples(context, next.text) != null) return {allowed: true, reason: '명시적 하이픈 뒤 부번'};
  if (first != null) {
    const allowed = detailLine.test(next.text.trim()) || count(context, '(') > count(context, ')');
    return {allowed, reason: allowed ? '상세주소/괄호 문맥' : '이미 완성된 기본주소'};
  }
  if (second != null && /(?:아파트|빌라|오피스텔|타운|푸르지오|래미안|힐스테이트|빌딩|회관|센터)$/.test(previous.text.trim())) {
    return {allowed: true, reason: '건물명 아래 기본주소'};
  }
  const tokens = previous.text.trim().split(/\s+/);
  const tail = tokens[tokens.length - 1] || '';
  const regionOrName = /^[가-힣0-9]+(?:도|시|군|구|읍|면|동|리|가|로|길)$/.test(tail);
  const number = startsWithBaseNumber(next.text);
  const followingName = /^(?:[가-힣0-9]+(?:도|시|군|구|읍|면|동|리|로|길)\s*)+$/.test(next.text.trim());
  if (regionOrName && (number || second != null || followingName)) {
    return {allowed: true, reason: number ? '주소명 뒤 번지/건물번호 + 상세주소' : '주소 계층'};
  }
  return {allowed: false, reason: '주소 연결 근거 부족/번호 경계 불명확'};
}

export function assembleLines(lines, trace = null) {
  const groups = [], uncertain = new Set(), barriers = [];
  const ordered = lines.filter(l => l.text.trim()).slice().sort((x, y) => (x.box.top - y.box.top) || (x.box.left - y.box.left));
  for (const line of ordered) {
    record(trace, `줄: ${line.text} @ ${boxText(line.box)}`);
    if (isNonAddressLine(line.text)) {
      record(trace, '제외: 이름/연락처/우편/부서/메모 필드');
      barriers.push(line);
      continue;
    }
    const eligible = groups.map((group, index) => index).filter(index => {
      const group = groups[index];
      const previousBox = group[group.length - 1].box;
      if (barriers.some(barrier => barrier.box.top >= previousBox.bottom - 1 && barrier.box.bottom <= line.box.top + 1 &&
        Math.min(barrier.box.right, previousBox.right) > Math.max(barrier.box.left, previousBox.left))) {
        record(trace, '연결 거부: 주소 사이의 다른 정보 필드');
        return false;
      }
      const decision = canJoin(group[group.length - 1], line, group.map(l => l.text).join('\n'));
      record(trace, `${group[group.length - 1].text} → ${line.text}: ${decision.reason}`);
      return decision.allowed;
    });
    if (eligible.length === 1) {
      const index = eligible[0];
      groups[index].push(line);
      if (/^\d{5}$/.test(line.text.trim())) uncertain.add(index);
    } else {
      if (eligible.length > 1) record(trace, '연결 거부: 가능한 앞줄이 여러 개');
      groups.push([line]);
    }
  }
  return groups.map((group, index) => ({text: group.map(l => l.text).join('\n'), box: bounds(group), requiresConfirmation: uncertain.has(index)}));
}

/** Rows of OCR elements (left→right); nearby elements of one row become one line. */
export function assembleElements(rows, trace = null) {
  const lines = rows.flatMap(elements => {
    const groups = [];
    for (const element of elements) {
      record(trace, `요소: ${element.text} @ ${boxText(element.box)}`);
      const group = groups[groups.length - 1];
      const previous = group?.[group.length - 1];
      if (!previous || element.box.left - previous.box.right > Math.max(boxHeight(previous.box), boxHeight(element.box)) * 1.8) groups.push([element]);
      else group.push(element);
    }
    return groups.map(group => ({text: group.map(e => e.text).join(' '), box: bounds(group)}));
  });
  return assembleLines(lines, trace);
}

/** Groups detected text boxes (PaddleOCR lines) into visual rows for assembleElements. */
export function rowsFromBoxes(items) {
  const rows = [];
  const ordered = items.filter(i => i.text && i.text.trim()).slice()
    .sort((a, b) => (a.box.top + a.box.bottom) - (b.box.top + b.box.bottom));
  for (const item of ordered) {
    const cy = (item.box.top + item.box.bottom) / 2, h = boxHeight(item.box);
    const row = rows.find(r => Math.abs(r.cy - cy) < Math.min(r.height, h) * 0.45);
    if (row) row.items.push(item);
    else rows.push({cy, height: h, items: [item]});
  }
  return rows.map(r => r.items.sort((a, b) => a.box.left - b.box.left).map(i => ({text: i.text.trim(), box: i.box})));
}

// ---- AddressTextParser.extractCandidatesFromOcrSamples (used by the dictionary engine) ----
export function extractCandidatesFromOcrSamples(samples, includePartial = false) {
  const normalizedSamples = samples.filter(s => s && s.trim()).map(normalizeOcrText);
  if (!normalizedSamples.length) return [];
  const variants = new Set(), lines = [];
  for (const sample of normalizedSamples) {
    for (const block of splitBlocks(sample)) {
      const blockLines = cleanLines(block);
      variants.add(restoreStructuredText(block).replace(/\n/g, ' '));
      variants.add(blockLines.join('\n'));
      for (const l of blockLines) variants.add(l);
      variants.add(blockLines.join(' '));
      addAdjacentLineRepairs(blockLines, variants);
      lines.push(...blockLines);
    }
  }
  // Two halves of one printed line may arrive as adjacent samples; repair only a road tail + suffix.
  for (let i = 0; i < normalizedSamples.length - 1; i++) {
    const left = cleanLines(normalizedSamples[i]).at(-1), right = cleanLines(normalizedSamples[i + 1])[0];
    if (left == null || right == null) continue;
    const repaired = repairRoadAcrossSamples(left, right);
    if (repaired != null) variants.add(repaired);
  }
  const distinctLines = [...new Set(lines)];
  for (const name of distinctLines.filter(l => addressNameOnly.test(l))) {
    for (const number of distinctLines.filter(l => numberOnly.test(l))) variants.add(`${name} ${number}`);
  }
  for (const possibleBase of distinctLines) {
    const base = extractCandidate(possibleBase);
    if (base && !base.text.includes('-') && normalizeKey(base.text) === normalizeKey(possibleBase)) {
      for (const suffixLine of distinctLines.filter(l => subNumberOnly.test(l))) variants.add(`${base.text}${suffixLine}`);
    }
  }
  return rankedCandidates(variants, includePartial).map(c => ({...c,
    details: normalizedSamples.map(s => extractDetails(s, c.text)).find(Boolean) || ''}));
}

// ---- CandidateTracker: keeps visible candidates stable across OCR frames ----
const completenessRank = c => (c.completeness === COMPLETE ? 1 : 0);
const isProvinceName = t => /(?:특별자치도|특별자치시|광역시|특별시|도)$/.test(t);
const isDistrictName = t => /(?:시|군|구)$/.test(t);
const isSubdistrictName = t => /(?:읍|면|리)$/.test(t);
function compatiblePath(left, right) {
  if (!left.length || !right.length) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const same = list => list.every((v, i) => v === shorter[i]);
  return same(longer.slice(0, shorter.length)) || same(longer.slice(longer.length - shorter.length));
}
function compatibleHierarchy(left, right) {
  if (!left.length || !right.length) return true;
  const l = left.map(normalizeKey), r = right.map(normalizeKey);
  const lp = l.find(isProvinceName), rp = r.find(isProvinceName);
  if (lp != null && rp != null && lp !== rp) return false;
  if (!compatiblePath(l.filter(isDistrictName), r.filter(isDistrictName))) return false;
  return compatiblePath(l.filter(isSubdistrictName), r.filter(isSubdistrictName));
}

/** Missing hierarchy may be completed later, but different explicit regions are never one address. */
export function isSameAddressFamily(left, right) {
  const a = parseParts(left.text), b = parseParts(right.text);
  if (!a || !b) return identity(left) === identity(right);
  return a.kind === b.kind &&
    (!left.details || !right.details || normalizeKey(left.details) === normalizeKey(right.details)) &&
    a.mountain === b.mountain && normalizeKey(a.name) === normalizeKey(b.name) &&
    (a.number == null || b.number == null || a.number === b.number) && compatibleHierarchy(a.prefix, b.prefix);
}

export class CandidateTracker {
  constructor(replaceAfterFrames = 3, emptyGraceMs = 2500) {
    this.replaceAfterFrames = replaceAfterFrames; this.emptyGraceMs = emptyGraceMs; this.clear();
  }
  update(incoming, nowMs) {
    if (this.frozen) return this.visible;
    if (!incoming.length) return nowMs - this.lastNonEmptyAt <= this.emptyGraceMs ? this.visible : [];
    this.lastNonEmptyAt = nowMs;
    if (!this.visible.length) { this.visible = incoming; return this.visible; }
    if (incoming.some(c => isSameAddressFamily(c, this.visible[0]))) {
      this.visible = this.mergeStable(this.visible, incoming); this.pendingSignature = null; this.pendingCount = 0;
      return this.visible;
    }
    const signature = incoming.map(identity).join('|');
    if (signature === this.pendingSignature) this.pendingCount++;
    else { this.pendingSignature = signature; this.pendingCount = 1; }
    if (this.pendingCount >= this.replaceAfterFrames) { this.visible = incoming; this.pendingSignature = null; this.pendingCount = 0; }
    return this.visible;
  }
  freeze(selected, alternatives = this.visible) {
    this.frozen = true;
    const seen = new Set();
    this.visible = [selected, ...alternatives].filter(c => { const k = identity(c); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
    return selected;
  }
  unfreeze(keepVisible = false) { this.frozen = false; this.pendingSignature = null; this.pendingCount = 0; if (!keepVisible) this.visible = []; }
  clear() { this.frozen = false; this.visible = []; this.pendingSignature = null; this.pendingCount = 0; this.lastNonEmptyAt = 0; }
  mergeStable(old, newer) {
    const result = old.slice();
    for (const c of newer) {
      const index = result.findIndex(e => isSameAddressFamily(e, c));
      if (index >= 0) {
        const existing = result[index];
        if (completenessRank(c) > completenessRank(existing) || c.confidence > existing.confidence || (!existing.details && c.details)) result[index] = c;
      } else result.push(c);
    }
    const seen = new Set();
    return result.filter(c => { const k = identity(c); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  }
}

/** Starts verification of observed addresses; never declares an address to be real. */
export class AutoConversionPolicy {
  constructor(replacementFrames = 2, minimumIntervalMs = 1200) {
    this.replacementFrames = replacementFrames; this.minimumIntervalMs = minimumIntervalMs;
    this.pending = null; this.count = 0; this.lastStartedAt = null; this.manuallyChosenFrom = [];
  }
  update(candidates, selected, nowMs) {
    const seen = new Set();
    const complete = candidates.filter(c => !c.manualOnly && !c.dictionaryCorrected && c.completeness === COMPLETE && parseParts(c.text)?.number != null)
      .filter(c => { const k = identity(c); if (seen.has(k)) return false; seen.add(k); return true; });
    // Multiple observed addresses need selection, not an arbitrary first-row choice.
    if (complete.length !== 1) { this.clearPending(); return null; }
    const next = complete[0];
    const sameAs = anchor => isSameAddressFamily(next, anchor) && (!next.details || normalizeKey(next.details) === normalizeKey(anchor.details || ''));
    if (selected && this.manuallyChosenFrom.some(sameAs)) { this.clearPending(); return null; }
    if (selected && sameAs(selected)) { this.clearPending(); return null; }
    if (selected) {
      const key = identity(next);
      if (this.pending === key) this.count++; else { this.pending = key; this.count = 1; }
      if (this.count < this.replacementFrames) return null;
    }
    if (this.lastStartedAt != null && nowMs - this.lastStartedAt < this.minimumIntervalMs) return null;
    this.onSelected(nowMs);
    return next;
  }
  onSelected(nowMs, observed = []) { this.lastStartedAt = nowMs; this.manuallyChosenFrom = observed.slice(); this.clearPending(); }
  clearPending() { this.pending = null; this.count = 0; }
  pause() { this.clearPending(); }
  reset() { this.clearPending(); this.lastStartedAt = null; this.manuallyChosenFrom = []; }
}

// ---- Romanizer / EnglishAddress (EMS) ----
// Korean names in the Revised Romanization of the road signs ('우정공원로' -> 'ujeonggongwon-ro'), sound changes
// inside a name only (신라 silla, 독립 dongnip); the road or place suffix joins with a hyphen ('종로' -> 'jong-ro').
const RR_INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const RR_VOWELS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const RR_FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const RR_LINKED = ['', 'g', 'kk', 'ks', 'n', 'nj', 'nh', 'd', 'r', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'ps', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];
const RR_SUFFIXES = ['대로', '로', '길', '동', '리', '읍', '면', '가'];
const isSyllable = c => c >= '가' && c <= '힣';
const syllable = c => c.charCodeAt(0) - 0xAC00;

export function romanizeWord(text) {
  let out = '';
  const chars = [...text];
  chars.forEach((c, i) => {
    if (!isSyllable(c)) { out += c.toLowerCase(); return; }
    const code = syllable(c), initial = Math.floor(code / 588), vowel = Math.floor((code % 588) / 28), fin = code % 28;
    const prevFinal = i > 0 && isSyllable(chars[i - 1]) ? syllable(chars[i - 1]) % 28 : 0;
    const next = i + 1 < chars.length && isSyllable(chars[i + 1]) ? Math.floor(syllable(chars[i + 1]) / 588) : null;
    let start;
    if (initial === 11) start = '';
    else if (initial === 5) start = ['l', 'n'].includes(RR_FINALS[prevFinal]) ? 'l' : RR_FINALS[prevFinal] === '' ? 'r' : 'n';
    else if (initial === 2 && RR_FINALS[prevFinal] === 'l') start = 'l';
    else start = RR_INITIALS[initial];
    let end = '';
    if (fin) {
      const sound = RR_FINALS[fin];
      if (next === 11) end = RR_LINKED[fin];
      else if (next === 2 || next === 6) end = ({k: 'ng', t: 'n', p: 'm'})[sound] || sound;
      else if (next === 5) end = ({k: 'ng', t: 'n', p: 'm', n: 'l'})[sound] || sound;
      else end = sound;
    }
    out += start + RR_VOWELS[vowel] + end;
  });
  return out;
}

export function romanize(name) {
  const numbered = /^(.*?(?:대로|로))(\d+)(번길|길)$/.exec(name);
  if (numbered) return `${romanize(numbered[1])} ${numbered[2]}${numbered[3] === '번길' ? 'beon-gil' : '-gil'}`;
  const suffix = RR_SUFFIXES.find(s => name.length > s.length && name.endsWith(s));
  if (!suffix) return romanizeWord(name);
  const stem = name.slice(0, -suffix.length), digits = /\d+$/.exec(stem)?.[0] || '';
  return digits ? `${romanizeWord(stem.slice(0, -digits.length))}${digits}-${romanizeWord(suffix)}` : `${romanizeWord(stem)}-${romanizeWord(suffix)}`;
}

// EMS and other parcels from abroad: an address in English is read against the chosen district's romanized roads
// and places, spelling forgiven, and turned into the Korean address the app reads (as on Android).
const EN_LATIN = /[A-Za-z]/g, EN_HANGUL = /[가-힣]/g;
const EN_MARKER = /(?:daero|ro|gil|dong|eup|myeon|ri|gu|si|korea)\b|\d{5}/i;
const EN_COUNTRY = /\b(?:republic\s+of\s+korea|south\s+korea|s\.?\s*korea|korea|rok)\b/gi;
const EN_PHONE_SOURCE = String.raw`(?:tel|phone|mobile|\+82)[^\n]*|\b0\d{1,2}[-. ]\d{3,4}[-. ]\d{4}\b`;
const EN_PHONE = new RegExp(EN_PHONE_SOURCE, 'gi');
const EN_PHONE_LINE = new RegExp(`^(?:${EN_PHONE_SOURCE})$`, 'i');
const EN_POSTAL = /(?<!\d)\d{5}(?!\d)/g;
const EN_TRANSLATED = [
  ['national university', 'daehak'], ['university', 'daehak'], ['univ', 'daehak'], ['city hall', 'sicheong'],
  ['park', 'gongwon'], ['station', 'yeok'], ['stn', 'yeok'], ['market', 'sijang'], ['hospital', 'byeongwon'],
  ['school', 'hakgyo'], ['river', 'gang'], ['bridge', 'gyo'], ['mountain', 'san'], ['mt', 'san'], ['lake', 'hosu'],
  ['church', 'gyohoe'], ['temple', 'sa'], ['port', 'hang'], ['harbor', 'hang'], ['harbour', 'hang'],
  ['airport', 'gonghang'], ['central', 'jungang'], ['center', 'senteo'], ['centre', 'senteo'],
  ['avenue', 'daero'], ['ave', 'daero'], ['boulevard', 'daero'], ['blvd', 'daero'],
  ['road', 'ro'], ['rd', 'ro'], ['street', 'ro'], ['st', 'ro'], ['lane', 'gil'], ['ln', 'gil'],
].map(([from, to]) => [new RegExp(String.raw`\b${from.replace(' ', String.raw`\s+`)}\b`, 'g'), to]);
const EN_FOLDS = [['woo', 'u'], ['oo', 'u'], ['ee', 'i'], ['eo', 'o'], ['ae', 'e'], ['eu', 'u'], ['ui', 'i'], ['wo', 'o'],
  ['ch', 'j'], ['sh', 's'], ['k', 'g'], ['p', 'b'], ['t', 'd'], ['r', 'l'], ['x', 's'], ['z', 'j'], ['f', 'b'], ['v', 'b'],
  ['c', 'g'], ['ll', 'l'], ['y', 'i']];

export function looksEnglish(text) {
  const letters = (text.match(EN_LATIN) || []).length;
  return letters >= 6 && (text.match(EN_HANGUL) || []).length * 3 < letters && EN_MARKER.test(text);
}

export function normalizeEnglish(text) {
  let s = text.toLowerCase().replace(/[–—]/g, '-').replace(/’/g, "'").replace(EN_PHONE, ' ').replace(EN_COUNTRY, ' ');
  for (const [word, korean] of EN_TRANSLATED) s = s.replace(word, korean);
  return s;
}

function foldWithPositions(text, positions) {
  let out = '';
  const kept = [];
  for (let i = 0; i < text.length;) {
    const fold = EN_FOLDS.find(([from]) => text.startsWith(from, i));
    const piece = fold ? fold[1] : text[i];
    const from = positions ? positions[i] : i;
    for (const ch of piece) { out += ch; kept.push(from); }
    i += fold ? fold[0].length : 1;
  }
  return [out, kept];
}
export const foldEnglish = text => foldWithPositions(text.toLowerCase().replace(/[^a-z0-9]/g, ''), null)[0];

function squeezed(text) {
  let out = '';
  const positions = [];
  [...text].forEach((c, i) => { if (/[a-z0-9]/.test(c)) { out += c; positions.push(i); } });
  return foldWithPositions(out, positions);
}

/** The cheapest stretch of `text` that the place's key can be edited into (approximate substring match). */
function within(text, place) {
  const p = place.key, n = text.length;
  if (!n) return null;
  let cost = new Array(n + 1).fill(0), start = Array.from({length: n + 1}, (_, j) => j);
  for (let i = 1; i <= p.length; i++) {
    const next = new Array(n + 1), nextStart = new Array(n + 1);
    next[0] = i; nextStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      const sub = cost[j - 1] + (p[i - 1] === text[j - 1] ? 0 : 1), del = cost[j] + 1, ins = next[j - 1] + 1;
      if (sub <= del && sub <= ins) { next[j] = sub; nextStart[j] = start[j - 1]; }
      else if (del <= ins) { next[j] = del; nextStart[j] = start[j]; }
      else { next[j] = ins; nextStart[j] = nextStart[j - 1]; }
    }
    cost = next; start = nextStart;
  }
  let end = -1;
  for (let j = 1; j <= n; j++) if (end < 0 || cost[j] < cost[end]) end = j;
  if (end <= 0 || start[end] >= end) return null;
  return {place, start: start[end], end, cost: cost[end]};
}

function bestPlace(text, places) {
  let best = null;
  for (const place of places) {
    if (place.key.length < 4) continue;
    const hit = within(text, place);
    if (!hit || hit.cost > Math.max(1, Math.floor(place.key.length / 5))) continue;
    // The kind of name must be written as it is: "-ro" is no "-dong" ("Jipbae-dong" is not "Jipbaedong-ro").
    if (hit.end < 2 || text.slice(hit.end - 2, hit.end) !== place.key.slice(-2)) continue;
    if (!best || hit.cost * best.place.key.length < best.cost * place.key.length ||
      (hit.cost * best.place.key.length === best.cost * place.key.length && place.key.length > best.place.key.length)) best = hit;
  }
  return best;
}

const EN_NUMBERED_ROAD = /^[\s,.-]*(\d{1,4})\s*-?\s*(beon)?\s*-?\s*gil\b/;
const EN_BUILDING_AFTER = /^[\s,.-]*((?:b\s*)?\d{1,4}(?:\s*-\s*\d{1,4})?)(?!\d|\s*-?\s*(?:dong|ho|f\b|fl|floor|cheung|beon|gil))/;
const EN_BUILDING_BEFORE = /(?<![\d#-])(\d{1,4}(?:-\d{1,4})?)[\s,]*$/;
const EN_PARCEL_AFTER = /^[\s,.-]*((?:san\s*)?\d{1,4}(?:\s*-\s*\d{1,4})?)(?!\d|\s*-?\s*(?:dong|ho))/;
const EN_DONG = /(?<![\d-])(\d{1,4})\s*-?\s*(?:dong|d|bldg|building)\b|(?<![a-z-])(?:bldg|building|dong)\.?\s*(\d{1,4})\b/;
const EN_HO = /(?<![\d-])(b?\d{1,5})\s*-?\s*ho\b|(?:#|\b(?:unit|room|rm|suite|ste|ho)\.?)\s*#?\s*(b?\d{1,5})(?!\s*-\s*\d)/;
const EN_PAIR = /(?:\b(?:apt|apartment|unit|#)\.?\s*#?\s*)?(?<![\d-])(\d{1,4})\s*-\s*(b?\d{2,5})(?![\d-])/g;

const buildingNumber = written => { const n = written.replace(/\s+/g, ''); return n.startsWith('b') ? `지하 ${n.slice(1)}` : n; };

function englishUnits(text, building) {
  const clean = text.replace(EN_POSTAL, ' ');
  const d = EN_DONG.exec(clean), h = EN_HO.exec(clean);
  let dong = d ? d[1] || d[2] : null, ho = h ? h[1] || h[2] : null, unsure = false;
  if (dong == null || ho == null) {
    const pair = [...clean.matchAll(EN_PAIR)].find(m => `${m[1]}-${m[2]}` !== building?.replace(/\s/g, ''));
    if (pair) {
      dong ??= pair[1];
      ho ??= pair[2];
      unsure = !pair[0].trim().startsWith('apt') && !pair[0].includes('#');
    }
  }
  const parts = [dong != null ? `${dong}동` : null, ho != null ? (ho.startsWith('b') ? `지하 ${ho.slice(1)}호` : `${ho}호`) : null].filter(Boolean);
  return [parts.join(' '), unsure && parts.length > 0];
}

function englishLine(text) {
  return text.split('\n').map(l => l.trim())
    .filter(l => l && !EN_PHONE_LINE.test(l.toLowerCase()) && /[A-Za-z]/.test(l))
    .join(', ').replace(/\s+/g, ' ');
}

/** Romanized keys of a district's roads ("우정로12번길" is found as 우정로; "중앙1길" stays a name of its own). */
export function englishPlaces(roads, localities) {
  return {
    roads: new Set(roads),
    roadPlaces: [...new Set(roads.map(r => r.replace(/(?<=로)\d+(?:번길|길)$/, '')))].map(name => ({name, key: foldEnglish(romanize(name))})),
    localityPlaces: localities.map(name => ({name, key: foldEnglish(romanize(name.split(' ').pop()))})),
  };
}

/** {korean, english, unitUnsure} for an address in English, or null; `places` from englishPlaces. */
export function englishAddress(text, district, places) {
  if (!looksEnglish(text)) return null;
  const english = englishLine(text), normal = normalizeEnglish(text);
  const [key, positions] = squeezed(normal);
  const roadHit = bestPlace(key, places.roadPlaces);
  if (roadHit) {
    const after = normal.slice(positions[roadHit.end - 1] + 1), before = normal.slice(0, positions[roadHit.start]);
    let road = roadHit.place.name, rest = after;
    const numbered = EN_NUMBERED_ROAD.exec(after);
    if (numbered) {
      const kinds = numbered[2] ? ['번길', '길'] : ['길', '번길'];
      const found = kinds.map(k => road + numbered[1] + k).find(r => places.roads.has(r));
      if (found) { road = found; rest = after.slice(numbered.index + numbered[0].length); }
    }
    // "12 Woojeong-ro" (number first, as English is written) is read too, after "Woojeong-ro 12".
    const numberAfter = EN_BUILDING_AFTER.exec(rest), numberBefore = numberAfter ? null : EN_BUILDING_BEFORE.exec(before);
    const written = (numberAfter || numberBefore)?.[1];
    const building = written != null ? buildingNumber(written) : null;
    const left = (numberBefore ? before.slice(0, numberBefore.index) : before) + ' ' +
      (numberAfter ? rest.slice(numberAfter.index + numberAfter[0].length) : rest);
    const [units, unsure] = englishUnits(left, building);
    return {korean: [district, road, building || '', units].filter(Boolean).join(' '), english, unitUnsure: unsure};
  }
  const placeHit = bestPlace(key, places.localityPlaces);
  if (!placeHit) return null;
  const after = normal.slice(positions[placeHit.end - 1] + 1), before = normal.slice(0, positions[placeHit.start]);
  const parcelMatch = EN_PARCEL_AFTER.exec(after), parcelBefore = parcelMatch ? null : EN_BUILDING_BEFORE.exec(before);
  const written = (parcelMatch || parcelBefore)?.[1];
  if (written == null) return null;
  const parcel = written.replace(/\s+/g, '').replace(/^san/, '산 ');
  const left = (parcelBefore ? before.slice(0, parcelBefore.index) : before) + ' ' +
    (parcelMatch ? after.slice(parcelMatch.index + parcelMatch[0].length) : after);
  const [units, unsure] = englishUnits(left, written.replace(/\s+/g, ''));
  return {korean: [district, placeHit.place.name, parcel, units].filter(Boolean).join(' '), english, unitUnsure: unsure};
}

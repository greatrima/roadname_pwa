import {
  COMPLETE, Kind, candidate as makeCandidate, extract, extractCandidate, extractDetails, parseParts, identity,
  restoreStructuredText, parseRegion, regionName, withDefaultRegion, candidatesFromBlocks, candidatesFromSpatialBlocks,
  automaticCandidate, assembleElements, rowsFromBoxes, CandidateTracker, AutoConversionPolicy, isSameAddressFamily,
} from './address-core.mjs';
import {AddressConverter, SOURCE_LABEL} from './address-convert.mjs';
import {AddressMemory, numberedWords} from './address-memory.mjs';
import {parseLocal, lookupLocal, gunzipText, correctNames, rememberDistrict, autoDistrict, mergeLocal, localEntries} from './local-address.mjs';
import {parseRackLabel, describe as describeEntry, describeApartment, apartmentAddresses, apartmentCells, assignApartment, locate, overlaps, piece, filledCount, exportText, importText, configured, cellCount, PRIORITY} from './sorting.mjs';
import {visibleRecent, addRecent} from './recent-address.mjs';

const $ = id => document.getElementById(id);
// Shown in settings; bump together with the service-worker cache version when deploying changes.
const APP_VERSION = '3.0.1';
// "업데이트 내역" of this version (the notes, written like the Android release notes); blank shows nothing.
const WHATS_NEW = `
### 개선점
**최근기록 수정**
- 노출 갯수 설정 가능
- 기록을 펼쳐도 결과가 밀리지 않음
`;
$('appVersion').textContent = APP_VERSION; $('appVersionBadge').textContent = `v${APP_VERSION}`;
const photo = $('photo'), overlay = $('selection'), ctx = photo.getContext('2d', {willReadFrequently: true});
let stream = null, hasPhoto = false, crop = null, drag = null, busy = false, job = 0, paddle = null, paddleReject = null, tess = null, cacheBusy = false;

// ---- device-local settings ----
const KEYS = {region: 'roadname-region', localities: 'roadname-localities', vworld: 'roadname-vworld-key', vworldDefault: 'roadname-vworld-default',
  kakao: 'roadname-kakao-key', map: 'roadname-map', engine: 'roadname-engine', continuous: 'roadname-continuous', offline: 'roadname-offline',
  developer: 'roadname-developer', hidden: 'roadname-hidden-buttons', alertVibrationOff: 'roadname-alert-vibration-off',
  alertSoundOff: 'roadname-alert-sound-off', memory: 'roadname-memory', memoryOff: 'roadname-memory-off', dictionaryChecked: 'roadname-dictionary-checked', installHint: 'roadname-install-hint-closed',
  seenVersion: 'roadname-seen-version', sorting: 'roadname-sorting', local: 'roadname-local', recent: 'roadname-recent-districts',
  offlineMode: 'roadname-offline-mode', recentLimit: 'roadname-recent-limit', recentMidnight: 'roadname-recent-midnight',
  recentAddresses: 'roadname-recent-addresses', recentOpen: 'roadname-recent-open', recentLines: 'roadname-recent-lines'};
const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} },
};
const flag = key => store.get(key) === '1';
// "오프라인 모드": no address server is asked, only the region's own data (taking that data still works).
const online = () => navigator.onLine && !flag(KEYS.offlineMode);
const continuousScan = () => flag(KEYS.continuous);
const developerMode = () => flag(KEYS.developer);
function currentRegion() {
  let localities = [];
  try { localities = JSON.parse(store.get(KEYS.localities) || '[]'); } catch {}
  return {...parseRegion(store.get(KEYS.region)), localities};
}

// A personal VWorld key overrides the default key published in the Jebichan Note remote config.
const converter = new AddressConverter({isOnline: online, getKeys: () => ({vworld: store.get(KEYS.vworld) || store.get(KEYS.vworldDefault), kakao: store.get(KEYS.kakao)})});
const REMOTE_CONFIG = 'https://raw.githubusercontent.com/greatrima/JebichanNote/main/remote-config/config.json';
let defaultKeyLoad = null;
function loadDefaultKey() {
  if (!online()) return Promise.resolve();
  defaultKeyLoad ??= fetch(REMOTE_CONFIG, {cache: 'no-store', signal: AbortSignal.timeout(8000)}).then(r => (r.ok ? r.json() : null))
    .then(config => { const key = String(config?.api?.VWORLD_API_KEY || '').trim(); if (/^[0-9A-Za-z-]{16,}$/.test(key)) store.set(KEYS.vworldDefault, key); })
    .catch(() => {}).finally(() => { defaultKeyLoad = null; });
  return defaultKeyLoad;
}

// ---- dictionary worker (Android dictionary + correction engine) ----
let dictionaryWorker = null, dictionarySeq = 0, dictionaryTree = null, dictionaryVersion = '';
const dictionaryPending = new Map();
function dictionaryCall(type, payload = {}) {
  if (!dictionaryWorker) {
    try { dictionaryWorker = new Worker('./dictionary-worker.mjs', {type: 'module'}); } catch { return Promise.reject(new Error('사전을 사용할 수 없습니다.')); }
    dictionaryWorker.onmessage = ({data}) => { const p = dictionaryPending.get(data.id); if (!p) return; dictionaryPending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result); };
    dictionaryWorker.onerror = () => { for (const p of dictionaryPending.values()) p.reject(new Error('사전을 불러오지 못했습니다.')); dictionaryPending.clear(); dictionaryWorker?.terminate(); dictionaryWorker = null; };
  }
  return new Promise((resolve, reject) => { const id = ++dictionarySeq; dictionaryPending.set(id, {resolve, reject}); dictionaryWorker.postMessage({id, type, ...payload}); });
}
async function loadDictionary() {
  const {version, tree} = await dictionaryCall('init');
  dictionaryTree = tree; dictionaryVersion = version; $('dictionaryVersion').textContent = version;
  return tree;
}
const dictionaryCandidates = (blocks, raw, region) => dictionaryCall('candidates', {blocks, raw, region}).catch(() => []);
const withinDistrict = (actual, selected) => actual === selected || actual.startsWith(`${selected} `);
function districtsOf(province) {
  const keys = Object.keys(dictionaryTree?.provinces?.[province] || {});
  return [...new Set(keys.flatMap(k => [k.split(' ')[0], k]))].sort((a, b) => a.localeCompare(b, 'ko'));
}
function localitiesOf(province, district) {
  const names = new Set();
  for (const [key, list] of Object.entries(dictionaryTree?.provinces?.[province] || {})) if (withinDistrict(key, district)) for (const n of list) names.add(n);
  return [...names].sort((a, b) => a.localeCompare(b, 'ko'));
}
function fillOptions(select, first, values, value) {
  select.replaceChildren(new Option(first, ''), ...values.map(v => new Option(v, v)));
  select.value = values.includes(value) ? value : '';
}
const ko = (x, y) => x.localeCompare(y, 'ko');
const splitDistrict = d => { const i = d.indexOf(' '); return i < 0 ? [d, ''] : [d.slice(0, i), d.slice(i + 1)]; };
const districtKeys = province => Object.keys(dictionaryTree?.provinces?.[province] || {});
async function loadRegions() {
  try {
    if (!dictionaryTree) await loadDictionary();
    const region = currentRegion(), [city, gu] = splitDistrict(region.district);
    fillOptions($('regionProvince'), '전체', Object.keys(dictionaryTree.provinces).sort(ko), region.province);
    renderCities(city, gu, region.localities);
    $('regionProvince').disabled = false; $('regionMessage').textContent = '';
  } catch { $('regionProvince').disabled = true; $('regionMessage').textContent = '지역 목록을 불러오지 못했습니다. 다시 열어주세요.'; }
}
function renderCities(city = '', gu = '', localities = []) {
  const province = $('regionProvince').value;
  $('regionCityLabel').textContent = /시$/.test(province) ? '구·군' : '시·군';
  fillOptions($('regionCity'), '전체', province ? [...new Set(districtKeys(province).map(k => splitDistrict(k)[0]))].sort(ko) : [], city);
  $('regionCity').disabled = !province;
  renderGus(gu, localities);
}
function renderGus(gu = '', localities = []) {
  const province = $('regionProvince').value, city = $('regionCity').value;
  const gus = city ? [...new Set(districtKeys(province).filter(k => k.startsWith(`${city} `)).map(k => splitDistrict(k)[1]))].sort(ko) : [];
  fillOptions($('regionGu'), '전체', gus, gu);
  $('regionGuGroup').hidden = !gus.length;
  renderLocalities(localities);
}
function selectedDistrict() { const city = $('regionCity').value, gu = $('regionGu').value; return city ? (gu ? `${city} ${gu}` : city) : ''; }
function renderLocalities(selected = []) {
  const province = $('regionProvince').value, district = selectedDistrict();
  const names = district ? localitiesOf(province, district) : [];
  $('regionLocality').replaceChildren(...names.map(n => { const o = new Option(n, n); o.selected = selected.includes(n); return o; }));
  $('regionLocalityGroup').hidden = !names.length;
}
function saveRegion() {
  // The local data follows the region (only once it was taken).
  setTimeout(() => { if (localMeta()) void downloadLocalData(true); }, 0);
  const province = $('regionProvince').value, district = province ? selectedDistrict() : '';
  const localities = district ? [...$('regionLocality').selectedOptions].map(o => o.value) : [];
  store.set(KEYS.region, province ? `${province}|${district}` : '');
  store.set(KEYS.localities, localities.length ? JSON.stringify(localities) : '');
  showRegion(); tracker.clear(); autoPolicy.reset();
}
function showRegion() {
  const region = currentRegion();
  $('regionName').textContent = (regionName(region) || '지역 설정 안 됨') + (region.localities.length ? ` · ${region.localities.length}곳` : '');
  if ($('regionValue')) settingsValues();
}

// ---- address state (Android MainActivity flow) ----
const WAITING_RESULT = '기준 주소를 인식하거나 입력해주세요';
let displayed = [], selected = null, requestSeq = 0, awaitingNetwork = false, converting = false, mapAddress = null, lastOcr = null, editing = false, candidateTouch = false, latestRaw = [];
const apiAlternatives = new Map();
const tracker = new CandidateTracker(), autoPolicy = new AutoConversionPolicy();
const uniqueCandidates = list => { const seen = new Set(); return list.filter(c => { const k = identity(c); if (seen.has(k)) return false; seen.add(k); return true; }); };

function setInput(text) { $('addressInput').value = text; $('copyAddress').disabled = !text.trim(); }
function setStatus(text) { $('statusText').textContent = text || ''; }
function showDetails(details) { $('detailText').hidden = !details; $('detailText').textContent = details ? `상세주소·건물: ${details}` : ''; }
function setMapAddress(address) { mapAddress = address; $('mapButton').disabled = !address; $('copyResult').disabled = !address; }
function setConverted(text, tone = '') {
  if (tone !== 'success' && shownResult) { shownResult = null; showSorting(); }
  const view = $('convertedText'), name = tone === 'success' ? parseParts(text)?.name : null, start = name ? text.indexOf(name) : -1;
  view.className = `converted-text${tone ? ` ${tone}` : ''}`;
  if (start < 0) { view.textContent = text; return; }
  // What is read on the street large ("달선로 50"), the 시·도/시·군·구 before it small; the text is still the whole address.
  const region = document.createElement('span'), main = document.createElement('span');
  region.className = 'converted-region'; region.textContent = text.slice(0, start);
  main.className = 'converted-name'; main.textContent = text.slice(start);
  view.replaceChildren(region, main);
}
function resetResult() { setMapAddress(null); setConverted(WAITING_RESULT); }
function setConverting(value) { converting = value; $('convertButton').disabled = value || busy || cacheBusy; }
const offlineStatus = () => '오프라인 · 주소 인식과 후보 선택은 사용할 수 있습니다.';

function clearAddressState() {
  requestSeq++; setConverting(false); selected = null; awaitingNetwork = false; lastOcr = null; editing = false; latestRaw = []; apiAlternatives.clear();
  tracker.clear(); autoPolicy.reset(); diag.reset();
  setInput(''); showDetails(''); resetResult(); setStatus(online() ? '' : offlineStatus()); renderCandidates([]);
}

function candidateView(c, isSelected) {
  if (isSelected) return {title: '선택됨', text: c.text, sub: c.alternativeTarget ? `→ ${c.alternativeTarget}` : c.details};
  if (c.manualOnly && c.alternativeTarget) return {title: '유사 주소 · 직접 선택', text: c.text, sub: `→ ${c.alternativeTarget}`};
  if (c.manualOnly) return {title: `${c.reviewReason || '사전 후보'} · 직접 선택`, text: c.text, sub: c.hint || c.details};
  if (c.completeness !== COMPLETE) return {title: '번호 인식 중', text: c.text, sub: ''};
  return {title: '', text: c.text, sub: c.details};
}
function renderCandidates(list) {
  if (candidateTouch) return;
  displayed = list.slice(0, 3);
  const box = $('candidateList'), selectedKey = selected ? identity(selected) : '';
  box.replaceChildren();
  for (const c of displayed) {
    const isSelected = identity(c) === selectedKey, view = candidateView(c, isSelected);
    const button = document.createElement('button');
    button.type = 'button'; button.className = `candidate${isSelected ? ' selected' : ''}${c.manualOnly ? ' manual' : ''}`;
    if (view.title) { const t = document.createElement('small'); t.textContent = view.title; button.append(t); }
    const main = document.createElement('span'); main.textContent = view.text; button.append(main);
    if (view.sub) { const s = document.createElement('small'); s.className = 'sub'; s.textContent = view.sub; button.append(s); }
    button.onclick = () => { candidateTouch = false; $('addressInput').blur(); acceptCandidate(c); };
    box.append(button);
  }
  $('candidatePanel').hidden = !displayed.length;
}

const liveCamera = () => !!stream && !hasPhoto;
function acceptCandidate(c, {manual = true} = {}) {
  editing = false;
  if (c.completeness !== COMPLETE) {
    // Keep a partial observation editable and keep reading the number; never invent it.
    requestSeq++; setConverting(false); selected = null; awaitingNetwork = false; autoPolicy.reset(); tracker.unfreeze(true);
    setInput(c.text); showDetails(''); resetResult(); setConverted('번호를 인식하는 중입니다');
    setStatus('부분 인식 후보입니다. 건물번호 또는 번지를 더 맞추거나 입력해 주세요.');
    if (!liveCamera()) { const input = $('addressInput'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    return;
  }
  const chosen = c.manualOnly ? apiAlternatives.get(identity(c)) : null;
  const alternatives = displayed.slice();
  autoPolicy.onSelected(performance.now(), manual ? latestRaw : []);
  tracker.freeze(c, alternatives);
  selected = c;
  if (!continuousScan()) stopScanning();
  setInput(c.text + (c.details ? ` ${c.details}` : '')); showDetails(c.details);
  renderCandidates(uniqueCandidates([c, ...alternatives]));
  if (chosen) { requestSeq++; setConverting(false); showSuccess(chosen); void learnConfirmed(chosen, true); }
  else void convertAddress(c.text, manual);
}

function submitManualAddress() {
  const raw = $('addressInput').value, found = extractCandidate(raw);
  if (!found) { setStatus('도로명·지명과 건물번호·번지를 함께 입력해 주세요.'); return; }
  const text = withDefaultRegion(found, currentRegion()).text;
  acceptCandidate({...found, text, details: extractDetails(raw, found.text)});
}

/** confirmed: typed, corrected or chosen by the user, so a found address may be remembered. */
async function convertAddress(raw, confirmed = false) {
  const parsed = extract(raw) ?? raw.trim();
  // Without a number, a building name of the region's own data still finds the address ("한빛아파트 104동").
  const byName = !parsed || parseParts(parsed)?.number == null ? lookupLocal(localData, raw) : null;
  if (!byName && (!parsed || parseParts(parsed)?.number == null)) { setStatus('도로명·지명과 건물번호·번지를 함께 입력해 주세요.'); return; }
  const id = ++requestSeq;
  awaitingNetwork = false; setMapAddress(null); setConverting(true);
  setConverted('주소를 확인하고 있습니다…'); setStatus('');
  diag.begin(parsed);
  // The region's own data first (offline too); the servers for anything it cannot tell.
  const local = byName || lookupLocal(localData, parsed);
  if (!local && !store.get(KEYS.vworld) && !store.get(KEYS.vworldDefault) && !store.get(KEYS.kakao)) await loadDefaultKey();
  const result = local ? {type: 'success', result: local} : await converter.convert(parsed);
  if (id !== requestSeq) return;
  setConverting(false);
  switch (result.type) {
    case 'success':
      countOutcome(true); showSuccess(result.result);
      if (confirmed) void learnConfirmed(result.result, true);
      else { unconfirmed = result.result; showAppliedCorrection(result.result); }
      break;
    case 'apiKeyMissing': showError('주소 변환용 API 키가 없습니다. 설정에서 등록해 주세요.'); break;
    case 'notFound': countOutcome(false); showError('일치하는 주소 없음'); break;
    case 'noExactMatch': {
      countOutcome(false); showError('일치하는 주소 없음');
      apiAlternatives.clear();
      const similar = result.suggestions.map(r => {
        const c = makeCandidate(r.recognizedAddress, r.recognizedKind, {confidence: 0, manualOnly: true, alternativeTarget: r.convertedAddress});
        apiAlternatives.set(identity(c), r);
        return c;
      });
      tracker.freeze(selected || makeCandidate(parsed, Kind.UNKNOWN), similar);
      renderCandidates(uniqueCandidates([...(selected ? [selected] : []), ...similar]));
      break;
    }
    case 'offline': signal(false); showLocalResult(true); break;
    default: signal(false); showLocalResult(!online(), `주소 서버에 연결하지 못했습니다. ${result.message}`);
  }
}

function showSuccess(r) {
  // While sorting, the address under the cell is in the form the rack's cells are written in.
  const rack = sortingOn() ? activeRack() : null, shown = rack ? preferredForm(r, rack) : r.convertedAddress;
  awaitingNetwork = false; setMapAddress(shown); diag.finish('완료', r.convertedAddress);
  setConverted(shown, 'success');
  setStatus(`${SOURCE_LABEL[r.source]}에서 확인된 주소입니다.`);
  shownResult = r;
  noteDistrict(r);
  saveRecent(addRecent(recentAll(), r, recentLimit(), flag(KEYS.recentMidnight)));
  showRecent();
  const changed = showSorting(true);
  signal(true, changed && sortingState().changeSound);
}
function showError(message) {
  awaitingNetwork = false; setMapAddress(null); diag.finish('검색 실패', message);
  const notFound = message === '일치하는 주소 없음';
  setConverted(notFound ? message : '변환할 수 없습니다', 'failure');
  setStatus(notFound ? '' : message);
  signal(false);
}

// ---- setting "내 수정 기억": names and corrections the user confirmed by hand, on this device only ----
const memory = new AddressMemory(store.get(KEYS.memory));
const memoryOn = () => !flag(KEYS.memoryOff);
let appliedCorrections = [], unconfirmed = null;
/** Remembers the confirmed address's name; `corrected` also learns the word the camera read for it. */
async function learnConfirmed(r, corrected) {
  unconfirmed = null;
  if (!memoryOn()) return;
  const parts = parseParts(r.recognizedAddress);
  if (!parts) return;
  memory.rememberName(parts.name);
  const source = lastOcr?.text || '', words = corrected && parts.number != null ? numberedWords(source) : [];
  if (words.length) {
    // Without the dictionary nothing is learned: a real name must never become a misreading.
    const real = await dictionaryCall('names', {names: words}).catch(() => null);
    if (real) memory.learnFromSource(source, parts.name, parts.number, word => real[words.indexOf(word)] !== false);
  }
  store.set(KEYS.memory, memory.serialize());
}
/** Tells that the shown address came from a remembered correction. */
function showAppliedCorrection(r) {
  const name = parseParts(r.recognizedAddress)?.name, applied = appliedCorrections.find(a => a.corrected === name);
  if (applied) setStatus(`내 수정 적용 · ${applied.misread} → ${applied.corrected}`);
}
/** Using a result that was converted by itself (copy, map) confirms it. */
function confirmUse() { if (unconfirmed) void learnConfirmed(unconfirmed, false); }
/** Remembered names first; the order is otherwise kept. */
function preferRemembered(list) {
  if (!memoryOn() || memory.isEmpty) return list;
  const weight = c => memory.weight(parseParts(c.text)?.name || '');
  return list.map((c, i) => [c, i]).sort((x, y) => weight(y[0]) - weight(x[0]) || x[1] - y[1]).map(x => x[0]);
}

// ---- conversion signal: a short tone and one vibration when converted, two vibrations and no tone when not ----
// iPhone Safari cannot vibrate, and plays sound only after a touch and with the ringer switch on.
let audio = null;
function unlockAudio() {
  try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') void audio.resume(); } catch {}
}
addEventListener('pointerdown', unlockAudio, {passive: true});
function signal(ok, cellChanged = false) {
  if (navigator.vibrate && !flag(KEYS.alertVibrationOff)) { try { navigator.vibrate(ok ? 40 : [70, 90, 70]); } catch {} }
  // A failure is told by vibration alone; where the phone cannot vibrate (iPhone) a low tone takes its place.
  if (flag(KEYS.alertSoundOff) || (!ok && navigator.vibrate)) return;
  try {
    unlockAudio();
    if (audio?.state !== 'running') return;
    const tone = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime, length = ok ? 0.12 : 0.28;
    tone.frequency.value = ok ? 1320 : 330;
    gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    tone.connect(gain).connect(audio.destination); tone.start(now); tone.stop(now + length + 0.01);
    if (ok && cellChanged) {
      // "칸 바뀌면 다른 소리": a second beep right after the first.
      const again = audio.createOscillator(), level = audio.createGain(), at = now + length + 0.06;
      again.frequency.value = 1760;
      level.gain.setValueAtTime(0.0001, at); level.gain.exponentialRampToValueAtTime(0.25, at + 0.01); level.gain.exponentialRampToValueAtTime(0.0001, at + length);
      again.connect(level).connect(audio.destination); again.start(at); again.stop(at + length + 0.01);
    }
  } catch {}
}
// Anonymous count of lookups that converted or found nothing: only the fixed path is sent, never the address.
// The counter keeps one per visitor and path, so one of each per opening is enough.
const counted = {ok: false, fail: false};
function countOutcome(ok) {
  const key = ok ? 'ok' : 'fail';
  if (counted[key] || !window.goatcounter?.count) return;
  counted[key] = true;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  try { window.goatcounter.count({path: `${standalone ? '/app' : '/web'}/${key}`, title: ok ? '변환 성공' : '변환 실패', event: true}); } catch {}
}
/** OCR/candidate selection is valid local work, not proof of a real address. */
function showLocalResult(offline, message = '') {
  awaitingNetwork = true; setMapAddress(null); diag.finish(offline ? '오프라인 · 변환 대기' : '검색 오류', offline ? '오프라인' : message);
  setConverted('주소 인식 완료 · 변환 대기');
  setStatus(offline ? '오프라인 · 인터넷 연결 후 ‘주소 변환’을 눌러주세요.' : `${message} ‘주소 변환’으로 다시 시도하세요.`);
}

/** "받는분" printed vertically glues its letters to the address lines; needs the loaded dictionary to tell real names. */
async function labelFree(texts) {
  if (!dictionaryVersion || !texts.some(text => /[받는분보내사람]/.test(text))) return texts;
  return dictionaryCall('clean', {texts}).catch(() => texts);
}
async function candidatesFromResult(result, region) {
  const lines = result.lines?.length ? result.lines : null, texts = await labelFree(lines ? lines.map(line => line.text) : [result.text]);
  diag.trace = [];
  appliedCorrections = [];
  // Road and 동 names misread by the camera are put right by the region's own data first.
  const remembered = raw => { const text = correctNames(localData, raw); if (!memoryOn()) return text; const r = memory.apply(text); appliedCorrections.push(...r.applied); return r.text; };
  if (!lines) { const text = remembered(texts[0]); return {raw: candidatesFromBlocks([text], region), blocks: [text]}; }
  const blocks = assembleElements(rowsFromBoxes(lines.map((line, i) => ({...line, text: remembered(texts[i])}))), developerMode() ? diag.trace : null);
  return {raw: candidatesFromSpatialBlocks(blocks, region), blocks: blocks.map(b => b.text)};
}

/** Photo / selection recognition: one frame, same gates as the first live frame. */
async function handleOcr(result) {
  lastOcr = result;
  const region = currentRegion();
  const {raw, blocks} = await candidatesFromResult(result, region);
  if (lastOcr !== result) return;
  latestRaw = raw;
  diag.observe(result, raw);
  const dictionary = preferRemembered(await dictionaryCandidates(blocks, raw, region));
  if (lastOcr !== result) return;
  requestSeq++; setConverting(false); selected = null; awaitingNetwork = false; apiAlternatives.clear(); tracker.clear(); autoPolicy.reset();
  renderCandidates(uniqueCandidates([...raw, ...dictionary]).slice(0, 5));
  const automatic = automaticCandidate(raw);
  if (automatic) { acceptCandidate(automatic, {manual: false}); return; }
  showDetails(''); resetResult();
  if ([...raw, ...dictionary].some(c => c.completeness === COMPLETE)) { setInput(''); setStatus('인식한 주소를 선택해 주세요.'); }
  else if (raw.length || dictionary.length) { setInput(''); setStatus('부분 인식 후보입니다. 번호가 보이도록 영역을 조절하거나 후보를 눌러 입력해 주세요.'); }
  else {
    setInput(restoreStructuredText(result.text).trim());
    setStatus(result.text.trim() ? '선택한 영역에서 주소를 찾지 못했습니다. 고친 뒤 ‘주소 변환’을 눌러주세요.' : '글자를 찾지 못했습니다. 주소를 더 크게 촬영해주세요.');
  }
}

// ---- live scanning (Android: automatic frames, tracker, auto-conversion gate, continuous mode) ----
let scanning = false, scanTimer = null, scanGeneration = 0, liveReady = false;
function updateScanUi() {
  const live = liveCamera();
  $('pauseButton').hidden = !(live && continuousScan());
  $('pauseButton').textContent = scanning ? '일시정지' : '재개';
  const guide = $('liveGuide');
  guide.classList.toggle('scanning', live && scanning);
  guide.dataset.state = !live ? '' : $('engine').value === 'tesseract' ? '수동 인식' : !scanning ? (selected ? '' : '일시정지') : liveReady ? '' : '준비 중';
  updateRunLabel();
}
function startScanning() {
  if (!liveCamera() || cacheBusy) return;
  scanning = true; scanGeneration++; editing = false; updateScanUi(); scheduleFrame(0);
}
function stopScanning() { scanning = false; scanGeneration++; clearTimeout(scanTimer); autoPolicy.pause(); updateScanUi(); }
function scheduleFrame(delay) { clearTimeout(scanTimer); const gen = scanGeneration; scanTimer = setTimeout(() => { if (gen === scanGeneration) void liveFrame(gen); }, delay); }
async function liveFrame(gen) {
  if (!scanning || gen !== scanGeneration) return;
  if (!liveCamera() || busy || cacheBusy || document.hidden || editing || $('engine').value === 'tesseract') { scheduleFrame(600); return; }
  const canvas = guideCanvas();
  if (!canvas) { scheduleFrame(300); return; }
  const started = performance.now();
  diag.area = `실시간 ${$('video').videoWidth}×${$('video').videoHeight} · 네모칸 ${canvas.width}×${canvas.height}`;
  diag.showCrop(canvas);
  let result = null;
  try { result = await paddleRecognize(canvas, data => { if (!liveReady && gen === scanGeneration) $('liveGuide').dataset.state = data.text; }); }
  catch (e) { diag.ocrStage = `OCR 오류: ${e.message}`; }
  finally { canvas.width = 1; canvas.height = 1; }
  if (gen !== scanGeneration || !scanning) return;
  if (!liveReady) { liveReady = true; updateScanUi(); }
  if (result) await onLiveResult(result, performance.now(), gen);
  if (gen === scanGeneration && scanning) scheduleFrame(Math.max(150, 350 - (performance.now() - started)));
}
async function onLiveResult(result, now, gen) {
  if (editing || $('addressInput') === document.activeElement) return;
  const region = currentRegion();
  const {raw, blocks} = await candidatesFromResult(result, region);
  if (gen !== scanGeneration || editing) return;
  lastOcr = result; latestRaw = raw;
  diag.observe(result, raw);
  if (!continuousScan() && selected) return;
  const automatic = autoPolicy.update(raw, selected, now);
  if (automatic) {
    tracker.unfreeze(true); acceptCandidate(automatic, {manual: false});
    // Android keeps the frame's dictionary alternatives selectable next to the automatic choice.
    const accepted = selected, dictionary = preferRemembered(await dictionaryCandidates(blocks, raw, region));
    if (selected !== accepted || apiAlternatives.size || !raw.some(c => !c.manualOnly && isSameAddressFamily(c, accepted))) return;
    const alternatives = uniqueCandidates([...displayed, ...raw, ...dictionary]);
    tracker.freeze(accepted, alternatives); renderCandidates(uniqueCandidates([accepted, ...alternatives]));
    return;
  }
  if (selected) return;
  const dictionary = raw.length ? await dictionaryCandidates(blocks, raw, region) : [];
  if (gen !== scanGeneration || !scanning || selected) return;
  renderCandidates(tracker.update(uniqueCandidates([...raw, ...dictionary]).slice(0, 5), now));
  if (displayed.length && !$('addressInput').value) setStatus(displayed.some(c => c.completeness === COMPLETE) ? '인식한 주소를 선택해 주세요.' : '');
}

function openMap() {
  if (!mapAddress) return;
  const query = encodeURIComponent(mapAddress), kakao = store.get(KEYS.map) === 'kakao';
  const app = kakao ? `kakaomap://search?q=${query}` : `nmap://search?query=${query}&appname=${encodeURIComponent(location.origin)}`;
  const web = kakao ? `https://map.kakao.com/link/search/${query}` : `https://map.naver.com/p/search/${query}`;
  let left = false;
  const hide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', hide);
  location.href = app;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', hide);
    if (left) return;
    // App not installed: offer the web map with a real tap (timers cannot open windows on iOS).
    const link = document.createElement('a'); link.href = web; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '웹 지도로 열기';
    $('statusText').replaceChildren(`${kakao ? '카카오맵' : '네이버지도'} 앱을 열지 못했습니다. `, link);
  }, 1500);
}
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); setStatus(done); }
  catch { setStatus('복사하지 못했습니다. 길게 눌러 복사해 주세요.'); }
}

// ---- developer diagnostics (screen only, never stored or sent) ----
const diag = {
  area: '', ocrText: '', extraction: '', ocrStage: '대기', searchStage: '대기', request: '', result: '', trace: [],
  reset() { Object.assign(this, {area: '', ocrText: '', extraction: '', ocrStage: '대기', searchStage: '대기', request: '', result: '', trace: []}); this.render(); },
  observe(result, raw) {
    this.ocrText = result.text; this.extraction = raw.map(c => `기본: ${c.text} / 상세: ${c.details}`).join('\n');
    this.ocrStage = !result.text.trim() ? 'OCR: 글자 없음' : raw.some(c => c.completeness === COMPLETE) ? '기본주소 추출 완료' : '주소 추출: 완성 주소 없음';
    this.render();
  },
  begin(query) { this.request = query; this.result = ''; this.searchStage = '검색 중'; this.render(); },
  finish(stage, message) { this.searchStage = stage; this.result = message; this.render(); },
  showCrop(canvas) {
    if (!developerMode()) return;
    const target = $('devCrop'), scale = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
    target.width = Math.max(1, Math.round(canvas.width * scale)); target.height = Math.max(1, Math.round(canvas.height * scale));
    target.getContext('2d').drawImage(canvas, 0, 0, target.width, target.height);
  },
  render() {
    $('devPanel').hidden = !developerMode();
    if (!developerMode()) return;
    $('devText').textContent = [`OCR 원문: ${this.ocrText}`, `실제 처리 영역: ${this.area}`, `추출 주소/상세주소: ${this.extraction}`,
      `OCR 상태: ${this.ocrStage}`, `API 요청 주소: ${this.request}`, `검색 상태: ${this.searchStage}`, `검색 결과/실패 원인: ${this.result}`,
      `줄·요소 연결 진단:\n${this.trace.join('\n')}`, '아래 이미지는 OCR 입력 영역입니다. 검색 결과가 아닙니다.'].join('\n');
  },
};

// ---- camera, guide box and photo selection ----
const seconds = ms => (ms / 1000).toFixed(2);
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function setBusy(value) {
  busy = value;
  for (const id of ['run', 'cameraButton', 'uploadButton', 'selectAll', 'rotate', 'reset', 'engine', 'nativeButton']) $(id).disabled = value || cacheBusy;
  $('run').disabled = value || cacheBusy || (!hasPhoto && !stream);
  $('convertButton').disabled = value || cacheBusy || converting;
  $('addressInput').readOnly = value; overlay.style.pointerEvents = value ? 'none' : 'auto'; $('progressPanel').hidden = !value;
}
function updateRunLabel() { $('run').textContent = liveCamera() ? '화면 정지' : '인식하기'; }
function progress(text, pct, detail) { $('status').textContent = text; if (Number.isFinite(pct)) $('progress').value = pct; else $('progress').removeAttribute('value'); if (detail) $('progressDetail').textContent = detail; }
function stopCamera() {
  stopScanning();
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null; $('video').srcObject = null; $('video').hidden = true; $('liveGuide').hidden = true; $('zoomRow').hidden = true; $('cameraButton').hidden = false; updateScanUi();
}
function clearResults() { $('results').replaceChildren(); $('resultDetails').hidden = true; $('resultDetails').open = false; clearAddressState(); }
function fitPhoto() { if (!hasPhoto) return; const scale = Math.min($('stage').clientWidth / photo.width, $('stage').clientHeight / photo.height); $('photoWrap').style.width = photo.width * scale + 'px'; $('photoWrap').style.height = photo.height * scale + 'px'; }
new ResizeObserver(fitPhoto).observe($('stage'));
function drawSelection() {
  const c = overlay.getContext('2d'); c.clearRect(0, 0, overlay.width, overlay.height); if (!crop) return;
  const {x, y, w, h} = crop; c.fillStyle = '#101c3680'; c.fillRect(0, 0, overlay.width, overlay.height); c.clearRect(x, y, w, h); c.strokeStyle = '#ff75ad'; c.lineWidth = Math.max(3, photo.width / 200); c.strokeRect(x, y, w, h);
}
function selectAll() { crop = {x: 0, y: 0, w: photo.width, h: photo.height}; drawSelection(); }
function showPhoto(source, initialCrop = null) {
  stopCamera(); const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  if (!sw || !sh) throw new Error('사진 크기를 읽을 수 없습니다. 다른 사진을 선택해주세요.');
  const factor = Math.min(1, 2400 / Math.max(sw, sh)); photo.width = Math.round(sw * factor); photo.height = Math.round(sh * factor); ctx.drawImage(source, 0, 0, photo.width, photo.height);
  overlay.width = photo.width; overlay.height = photo.height; hasPhoto = true; $('empty').hidden = true; $('photoWrap').hidden = false; $('cropTools').hidden = false; $('cameraFallback').hidden = true;
  document.querySelector('.camera-pane').classList.add('has-photo'); fitPhoto(); clearResults(); error(''); setBusy(false);
  if (initialCrop) { crop = {x: initialCrop.x * factor, y: initialCrop.y * factor, w: initialCrop.w * factor, h: initialCrop.h * factor}; drawSelection(); }
  else selectAll();
  updateScanUi();
}
async function openCamera() {
  if (busy || cacheBusy) return; error(''); stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) { $('cameraFallback').hidden = false; error('Safari에서 열어주세요. 기본 카메라 촬영이나 사진 선택도 가능합니다.'); return; }
  $('cameraButton').disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}});
    $('video').srcObject = stream; $('video').hidden = false; await $('video').play(); $('photoWrap').hidden = true; $('empty').hidden = true; $('cropTools').hidden = true; $('liveGuide').hidden = false; $('zoomRow').hidden = false; $('cameraButton').hidden = true; $('cameraFallback').hidden = true;
    hasPhoto = false; document.querySelector('.camera-pane').classList.remove('has-photo'); $('run').disabled = false; $('zoom').value = 1; updateZoom();
    startScanning();
  } catch (e) {
    stopCamera(); $('empty').hidden = hasPhoto; $('photoWrap').hidden = !hasPhoto; $('cropTools').hidden = !hasPhoto; $('cameraFallback').hidden = false;
    error(e.name === 'NotAllowedError' ? '카메라 권한을 허용해주세요. 사진 선택이나 기본 카메라 촬영도 가능합니다.' : '카메라를 열지 못했습니다. 기본 카메라 촬영 또는 사진 선택을 이용해주세요.');
  } finally { $('cameraButton').disabled = false; }
}
function updateZoom() { const z = Number($('zoom').value); $('video').style.transform = `scale(${z})`; $('zoomValue').value = z.toFixed(1) + '×'; }

/** Maps an on-screen rectangle to video pixels (object-fit: cover + CSS zoom around the centre). */
function videoRect(rect) {
  const v = $('video'), stage = $('stage').getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight, z = Number($('zoom').value) || 1;
  if (!vw || !vh || !stage.width || !stage.height) return null;
  const s = Math.max(stage.width / vw, stage.height / vh), ox = (stage.width - vw * s) / 2, oy = (stage.height - vh * s) / 2;
  const cx = stage.width / 2, cy = stage.height / 2;
  const map = (x, y) => [((cx + (x - stage.left - cx) / z) - ox) / s, ((cy + (y - stage.top - cy) / z) - oy) / s];
  const [x1, y1] = map(rect.left, rect.top), [x2, y2] = map(rect.right, rect.bottom);
  const x = Math.max(0, x1), y = Math.max(0, y1), r = Math.min(vw, x2), b = Math.min(vh, y2);
  return r - x > 8 && b - y > 8 ? {x, y, w: r - x, h: b - y} : null;
}
function guideRect() { const g = $('liveGuide').getBoundingClientRect(), inset = 2; return {left: g.left + inset, top: g.top + inset, right: g.right - inset, bottom: g.bottom - inset}; }
/** Pixels inside the guide box only, like the Android scan frame. */
function guideCanvas(maxSide = 1600) {
  const r = videoRect(guideRect());
  if (!r) return null;
  const scale = Math.min(1, maxSide / Math.max(r.w, r.h)), c = document.createElement('canvas');
  c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
  c.getContext('2d').drawImage($('video'), r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}
/** Freeze: keep the visible frame, pre-select the guide box, then recognize that selection. */
function capture() {
  const v = $('video'), visible = videoRect($('stage').getBoundingClientRect()), guide = videoRect(guideRect());
  if (!visible) return false;
  const c = document.createElement('canvas'); c.width = Math.round(visible.w); c.height = Math.round(visible.h);
  c.getContext('2d').drawImage(v, visible.x, visible.y, visible.w, visible.h, 0, 0, c.width, c.height);
  showPhoto(c, guide ? {x: guide.x - visible.x, y: guide.y - visible.y, w: guide.w, h: guide.h} : null);
  return true;
}
async function readFile(file) {
  if (!file || busy || cacheBusy) return; error(''); const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); showPhoto(img); } catch { error('사진을 읽지 못했습니다. JPG·PNG 사진 또는 기본 카메라 촬영을 이용해주세요.'); } finally { URL.revokeObjectURL(url); }
}
function point(e) { const r = overlay.getBoundingClientRect(); return {x: Math.max(0, Math.min(photo.width, (e.clientX - r.left) * photo.width / r.width)), y: Math.max(0, Math.min(photo.height, (e.clientY - r.top) * photo.height / r.height))}; }
overlay.addEventListener('pointerdown', e => { if (busy) return; drag = {...point(e), previous: crop}; overlay.setPointerCapture(e.pointerId); });
overlay.addEventListener('pointermove', e => { if (!drag) return; const p = point(e); crop = {x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y)}; drawSelection(); });
function endDrag() { if (!drag) return; if (!crop || crop.w < 20 || crop.h < 12) { crop = drag.previous; drawSelection(); } else { clearResults(); setStatus('영역을 바꿨습니다. ‘인식하기’를 눌러주세요.'); } drag = null; }
overlay.addEventListener('pointerup', endDrag); overlay.addEventListener('pointercancel', endDrag);
function selectedCanvas() { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(crop.w)); c.height = Math.max(1, Math.round(crop.h)); c.getContext('2d').drawImage(photo, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height); return c; }

// ---- OCR engines (one PaddleOCR request at a time) ----
let ocrQueue = Promise.resolve();
function disposePaddle() { paddle?.terminate(); paddle = null; liveReady = false; if (paddleReject) { paddleReject(new Error('취소됨')); paddleReject = null; } }
async function disposeTess() { const current = tess; tess = null; if (current) await current.terminate(); }
function paddleRecognize(canvas, onProgress) {
  const run = () => new Promise((resolve, reject) => {
    if (!window.Worker || !window.OffscreenCanvas) { reject(new Error('이 Safari에서는 PaddleOCR 실행에 필요한 기능이 없습니다. iOS를 업데이트하거나 Tesseract를 선택해주세요.')); return; }
    if (!canvas.width || canvas.width < 2) { reject(new Error('취소됨')); return; }
    if (!paddle) paddle = new Worker('./paddle-worker.js');
    paddleReject = reject;
    paddle.onmessage = ({data}) => { if (data.type === 'progress') onProgress?.(data); else { paddleReject = null; data.type === 'result' ? resolve(data) : reject(new Error(data.message)); } };
    paddle.onerror = e => { paddleReject = null; reject(new Error(e.message || '한국어 인식기를 실행하지 못했습니다. 페이지를 다시 열어주세요.')); };
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    paddle.postMessage({width: canvas.width, height: canvas.height, pixels: pixels.buffer}, [pixels.buffer]);
  });
  const task = ocrQueue.then(run, run);
  ocrQueue = task.catch(() => {});
  return task;
}
async function tesseractRun(canvas, id) {
  let loadMs = 0;
  if (!tess) {
    const t = performance.now(); progress('Tesseract 모델 불러오는 중', null);
    if (!window.Tesseract) throw new Error('비교용 OCR 파일을 불러오지 못했습니다. 인터넷 연결 후 다시 열어주세요.');
    const candidate = await Tesseract.createWorker('kor+eng', 1, {workerPath: new URL('./vendor/worker.min.js', location.href).href, corePath: new URL('./vendor/', location.href).href, langPath: new URL('./models/', location.href).href, workerBlobURL: false, cacheMethod: 'none', logger: m => { if (id === job) progress(m.status === 'recognizing text' ? '한국어 읽는 중' : 'Tesseract 준비 중', Math.round((m.progress || 0) * 100)); }});
    if (id !== job) { await candidate.terminate(); throw new Error('취소됨'); } tess = candidate;
    await tess.setParameters({tessedit_pageseg_mode: '6', preserve_interword_spaces: '1'}); loadMs = performance.now() - t;
  }
  const start = performance.now(), {data} = await tess.recognize(canvas, {}, {text: true, blocks: false});
  return {engine: 'Tesseract', text: data.text.trim(), confidence: data.confidence, loadMs, inferMs: performance.now() - start, backend: 'WASM · CPU'};
}
function showResultCard(r) {
  $('resultDetails').hidden = false;
  const card = document.createElement('article'); card.className = 'result-card';
  const head = document.createElement('div'); head.className = 'result-head'; const title = document.createElement('h2'); title.textContent = r.engine; const time = document.createElement('span'); time.className = 'time'; time.textContent = seconds(r.inferMs) + '초'; head.append(title, time);
  const meta = document.createElement('p'); meta.className = 'result-meta'; meta.textContent = `모델 준비 ${seconds(r.loadMs)}초 · 인식 ${seconds(r.inferMs)}초 · ${r.backend}`;
  const area = document.createElement('textarea'); area.readOnly = true; area.setAttribute('aria-label', r.engine + ' 인식 결과'); area.value = r.text; area.placeholder = '글자를 찾지 못했습니다.';
  const actions = document.createElement('div'); actions.className = 'result-actions'; const score = document.createElement('span'); score.textContent = r.text ? `인식 점수 ${Math.round(r.confidence)} / 100` : '인식된 글자 없음';
  const use = document.createElement('button'); use.className = 'use-result'; use.textContent = '이 결과로 주소 찾기'; use.disabled = !r.text; use.onclick = () => { void handleOcr(r); $('informationScroll').scrollTo({top: 0, behavior: 'smooth'}); };
  actions.append(score, use); card.append(head, meta, area, actions); $('results').append(card);
}
async function run() {
  if (busy || cacheBusy || !hasPhoto) return; const id = ++job, canvas = selectedCanvas(), choice = $('engine').value; clearResults(); error(''); setBusy(true); progress('인식 준비 중', null, '첫 실행에는 모델 준비 시간이 추가됩니다.');
  diag.area = `정지 사진 ${photo.width}×${photo.height} · 선택 영역 ${canvas.width}×${canvas.height}`; diag.showCrop(canvas);
  const timeout = setTimeout(() => { if (id === job) { cancel(); error('인식 시간이 90초를 넘었습니다. 주소 영역을 좁히거나 다른 인식 방식을 선택해주세요.'); } }, 90000);
  let primary = null;
  try {
    const engines = choice === 'compare' ? ['paddle', 'tesseract'] : [choice];
    for (const name of engines) {
      if (id !== job) return;
      try {
        if (name === 'paddle') await disposeTess(); else disposePaddle();
        const result = await (name === 'paddle' ? paddleRecognize(canvas, d => { if (id === job) progress(d.text, d.progress); }) : tesseractRun(canvas, id));
        if (id !== job) return; showResultCard(result); primary ??= result;
      } catch (e) { if (id !== job) return; error(`${name === 'paddle' ? 'PaddleOCR' : 'Tesseract'}: ${e.message}`); name === 'paddle' ? disposePaddle() : await disposeTess(); }
    }
  } finally { clearTimeout(timeout); canvas.width = 1; canvas.height = 1; if (id === job) { setBusy(false); void checkCache(); } }
  if (id === job && primary) { $('resultDetails').open = choice === 'compare'; await handleOcr(primary); }
}
function cancel() { job++; disposePaddle(); void disposeTess(); setBusy(false); }
function resumeScanning() {
  // Android "다시 인식": clear the selection and read the next address.
  $('results').replaceChildren(); $('resultDetails').hidden = true; clearAddressState(); error(''); $('informationScroll').scrollTop = 0;
  if (liveCamera()) startScanning();
  else {
    hasPhoto = false; crop = null; photo.width = 1; photo.height = 1; overlay.width = 1; overlay.height = 1;
    document.querySelector('.camera-pane').classList.remove('has-photo'); $('empty').hidden = false; $('photoWrap').hidden = true; $('cropTools').hidden = true;
    setBusy(false); void openCamera();
  }
}

// ---- settings: buttons, toggles, dictionary ----
const BUTTONS = [['regionButton', '지역'], ['mapButton', '지도에서 보기'], ['convertButton', '주소 변환'], ['run', '화면 정지·인식하기'], ['copyAddress', '인식 주소 복사'], ['copyResult', '변환 주소 복사']];
const hiddenButtons = () => { try { return JSON.parse(store.get(KEYS.hidden) || '[]'); } catch { return []; } };
function applyButtonVisibility() {
  const hidden = hiddenButtons();
  for (const [id] of BUTTONS) $(id).classList.toggle('user-hidden', hidden.includes(id));
}
function renderButtonSettings() {
  const hidden = hiddenButtons(), list = $('buttonSettings');
  list.replaceChildren(...BUTTONS.map(([id, label]) => {
    const row = document.createElement('label'); row.className = 'toggle'; const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = !hidden.includes(id);
    box.onchange = () => { const next = hiddenButtons().filter(x => x !== id); if (!box.checked) next.push(id); store.set(KEYS.hidden, next.length ? JSON.stringify(next) : ''); applyButtonVisibility(); };
    row.append(box, label); return row;
  }));
}
function bindToggle(id, key, after) {
  $(id).checked = flag(key);
  $(id).onchange = () => { store.set(key, $(id).checked ? '1' : ''); after?.(); };
}
async function updateDictionary(manual) {
  if (!online()) { if (manual) $('dictionaryMessage').textContent = '인터넷 연결이 필요합니다. 내장 사전으로 인식·교정은 계속 사용할 수 있습니다.'; return; }
  if (manual) $('dictionaryMessage').textContent = '주소 사전을 확인하고 있습니다…';
  try {
    const result = await dictionaryCall('update');
    store.set(KEYS.dictionaryChecked, '1');
    if (result.status === 'updated') { dictionaryTree = result.tree; dictionaryVersion = result.version; $('dictionaryVersion').textContent = result.version; }
    if (manual) $('dictionaryMessage').textContent = result.status === 'updated' ? `주소 사전을 ${result.version} 버전으로 업데이트했습니다.` : '최신 주소 사전을 사용 중입니다.';
  } catch (e) { if (manual) $('dictionaryMessage').textContent = `주소 사전 업데이트 실패: ${e.message}`; }
}

// ---- wiring ----
$('cameraButton').onclick = openCamera; $('zoom').oninput = updateZoom;
$('pauseButton').onclick = () => { if (scanning) stopScanning(); else startScanning(); };
$('uploadButton').onclick = () => $('upload').click(); $('nativeButton').onclick = () => $('nativeCapture').click();
for (const id of ['upload', 'nativeCapture']) $(id).onchange = e => { readFile(e.target.files[0]); e.target.value = ''; };
$('selectAll').onclick = () => { selectAll(); clearResults(); };
$('rotate').onclick = () => { const c = document.createElement('canvas'); c.width = photo.height; c.height = photo.width; const x = c.getContext('2d'); x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(photo, 0, 0); showPhoto(c); };
$('reset').onclick = resumeScanning;
$('run').onclick = () => { if (busy || cacheBusy) return; if (liveCamera()) { if (!capture()) return; } run(); };
$('cancel').onclick = cancel;
$('convertButton').onclick = () => { $('addressInput').blur(); submitManualAddress(); };
$('candidateList').addEventListener('pointerdown', () => { candidateTouch = true; });
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) $('candidateList').addEventListener(type, () => setTimeout(() => { candidateTouch = false; }, 0));
let focusValue = '';
$('addressInput').addEventListener('focus', () => { editing = true; focusValue = $('addressInput').value; showRecent(); });
// Tapping into the field and leaving it unchanged must not keep live scanning paused.
$('addressInput').addEventListener('blur', () => { if ($('addressInput').value === focusValue) editing = false; });
$('addressInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('addressInput').blur(); submitManualAddress(); } });
$('addressInput').oninput = () => {
  // Editing cancels pending lookups; an old response must not replace the edited address.
  editing = true; requestSeq++; setConverting(false); awaitingNetwork = false; showDetails(''); resetResult(); setStatus(''); diag.finish('편집 중 · 검색 취소', '');
  $('copyAddress').disabled = !$('addressInput').value.trim();
  showRecent();
};

// ---- "최근 주소": under the empty, focused input, newest first; a tap converts it again ----
const recentLines = () => Math.min(10, Math.max(2, parseInt(store.get(KEYS.recentLines), 10) || 3));
const recentLimit = () => Math.max(0, parseInt(store.get(KEYS.recentLimit), 10) || 0);
function recentAll() { try { return JSON.parse(store.get(KEYS.recentAddresses) || '[]'); } catch { return []; } }
const saveRecent = list => store.set(KEYS.recentAddresses, list.length ? JSON.stringify(list) : '');
const recentEntries = () => visibleRecent(recentAll(), recentLimit(), flag(KEYS.recentMidnight));
const CLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
/** "→ 우정안길 28": the result without its 시·도 and 시·군·구. */
function shortResult(converted) {
  const parts = parseParts(converted);
  const short = parts ? [parts.name, parts.number].filter(v => v != null && v !== '').join(' ') : '';
  return short || converted || '';
}
/** "08:42" today, "어제", else "10/24". */
function recentTime(at) {
  const then = new Date(at), now = new Date(), yesterday = new Date(now - 864e5);
  if (then.toDateString() === now.toDateString()) return `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  if (then.toDateString() === yesterday.toDateString()) return '어제';
  return `${then.getMonth() + 1}/${then.getDate()}`;
}
function recentRow(e, onPick) {
  const row = document.createElement('button'), text = document.createElement('span'), sub = document.createElement('small');
  row.type = 'button'; row.className = 'recent-item';
  row.insertAdjacentHTML('afterbegin', CLOCK);
  text.append(e.recognized);
  sub.textContent = [e.converted && e.converted !== e.recognized ? `→ ${shortResult(e.converted)}` : '', recentTime(e.at)].filter(Boolean).join('   ');
  text.append(sub); row.append(text);
  if (onPick) row.onclick = () => onPick(e);
  return row;
}
/** "우정동 228-2": an address without its 시·도 and 시·군·구. */
function shortAddress(address) {
  const parts = parseParts(address);
  return (parts ? [parts.name, parts.number].filter(v => v != null && v !== '').join(' ') : '') || address;
}
/** One line: "우정동 228-2  → 우정안길 28" and the time on the right. */
function recentLine(e, onPick) {
  const row = document.createElement('button'), text = document.createElement('span'), time = document.createElement('small');
  row.type = 'button'; row.className = 'recent-line';
  text.append(shortAddress(e.recognized));
  if (e.converted && e.converted !== e.recognized) text.append(Object.assign(document.createElement('em'), {textContent: `→ ${shortResult(e.converted)}`}));
  time.textContent = recentTime(e.at);
  row.append(text, time);
  row.setAttribute('aria-label', `최근 기록 ${e.recognized}`);
  row.onclick = () => onPick(e);
  return row;
}
/**
 * "최근 기록" under the input while it has addresses: folded, a thin divider ("── 최근 기록 ──── ▾"); opened, one
 * line per address, at most three in sight and the rest scrolled inside, so the result below is never pushed off the
 * screen. Opened or folded stays as chosen.
 */
function showRecent() {
  const list = $('recentList'), entries = recentEntries(), open = flag(KEYS.recentOpen);
  const header = document.createElement('button');
  header.type = 'button'; header.className = 'recent-header';
  header.setAttribute('aria-expanded', String(open));
  header.setAttribute('aria-label', open ? '최근 기록 접기' : '최근 기록 펼치기');
  header.append(Object.assign(document.createElement('span'), {className: 'recent-title', textContent: '최근 기록'}),
    Object.assign(document.createElement('span'), {className: 'recent-fold', textContent: open ? '▴' : '▾'}));
  header.onclick = () => { store.set(KEYS.recentOpen, open ? '' : '1'); showRecent(); };
  const rows = document.createElement('div');
  rows.className = 'recent-rows';
  rows.append(...entries.map(e => recentLine(e, pick => {
    $('addressInput').value = pick.recognized; $('addressInput').blur();
    $('copyAddress').disabled = false; submitManualAddress();
  })));
  // At most the chosen number of lines in sight (3 unless set, 2~10); more scroll inside.
  rows.style.maxHeight = `${recentLines() * 40 + 20}px`;
  list.replaceChildren(header, ...(open ? [rows] : []));
  list.hidden = !entries.length;
}
function renderRecentPage() {
  const entries = recentEntries();
  $('recentItems').replaceChildren(...(entries.length ? entries.map(e => recentRow(e, null)) : [Object.assign(document.createElement('p'), {className: 'cache-message', textContent: '최근 주소가 없습니다.'})]));
}
$('recentLimit').onchange = () => {
  const limit = Math.min(999, Math.max(0, parseInt($('recentLimit').value, 10) || 0));
  store.set(KEYS.recentLimit, limit ? String(limit) : '');
  saveRecent(recentAll().slice(0, limit));
  settingsValues(); showRecent();
};
$('recentLines').onchange = () => {
  const lines = parseInt($('recentLines').value, 10);
  store.set(KEYS.recentLines, lines ? String(Math.min(10, Math.max(2, lines))) : '');
  settingsValues(); showRecent();
};
$('recentMidnight').onchange = () => store.set(KEYS.recentMidnight, $('recentMidnight').checked ? '1' : '');
$('clearRecent').onclick = () => { saveRecent([]); $('recentMessage').textContent = '최근 주소를 지웠습니다.'; settingsValues(); showRecent(); };

/** "기억 목록": corrections ("우저4긱 → 우정4길") and names, newest first; × forgets one. */
function renderMemoryList() {
  const item = (text, forget) => {
    const row = document.createElement('div'), remove = document.createElement('button');
    row.className = 'memory-item'; row.append(Object.assign(document.createElement('span'), {textContent: text}));
    remove.className = 'secondary'; remove.textContent = '삭제'; remove.setAttribute('aria-label', `${text} 삭제`);
    remove.onclick = () => { forget(); store.set(KEYS.memory, memory.serialize()); renderMemoryList(); settingsValues(); };
    row.append(remove);
    return row;
  };
  const rows = [...[...memory.pairs].reverse().map(([misread, corrected]) => item(`${misread} → ${corrected}`, () => memory.pairs.delete(misread))),
    ...[...memory.names.keys()].reverse().map(name => item(name, () => memory.names.delete(name)))];
  $('memoryItems').replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), {className: 'cache-message', textContent: '기억한 것이 없습니다.'})]));
}

// ---- "아파트 사전설정" of the active rack: name, main address, shops' addresses with commas, and the 동별 칸 table ----
let editingApartment = null;
function renderApartments() {
  const rack = activeRack();
  $('apartmentList').replaceChildren(...(rack?.apartments || []).map((a, i) => {
    const row = document.createElement('button');
    row.append(a.name, Object.assign(document.createElement('span'), {className: 'row-end', textContent: apartmentAddresses(a)[0] || ''}));
    row.onclick = () => { editingApartment = i; showSettingsPage('apartment'); };
    return row;
  }));
  $('addApartment').disabled = !rack;
}
function renderApartment() {
  const rack = activeRack(), a = rack?.apartments?.[editingApartment] || {name: '', main: '', shops: ''};
  $('settingsTitle').textContent = a.name || '아파트 추가';
  $('aptName').value = a.name; $('aptMain').value = a.main || ''; $('aptShops').value = a.shops || '';
  $('deleteApartment').hidden = editingApartment == null;
  // "동별 칸": a 동 ("101", "상가", "전체") and its cell per line; saving writes them into the cells' labels.
  const cells = a.name && rack ? apartmentCells(rack.labels, a.name) : [];
  $('aptTable').replaceChildren();
  for (const [unit, cell] of cells) addUnitLine(unit, cell);
  for (let i = cells.length ? 1 : 2; i > 0; i--) addUnitLine('', '');
}
function addUnitLine(unit, cell) {
  const line = document.createElement('div'), u = document.createElement('input'), c = document.createElement('input');
  line.className = 'apt-line';
  u.placeholder = '동 (101, 상가, 전체)'; u.value = unit; u.setAttribute('aria-label', '동');
  c.placeholder = '칸'; c.value = cell; c.inputMode = 'numeric'; c.setAttribute('aria-label', '칸');
  line.append(u, c); $('aptTable').append(line);
}
$('aptAddUnit').onclick = () => addUnitLine('', '');
$('addApartment').onclick = () => { editingApartment = null; showSettingsPage('apartment'); };
$('saveApartment').onclick = () => {
  const rack = activeRack(), name = $('aptName').value.trim();
  if (!rack || !name) return;
  const apartment = {name, main: $('aptMain').value.trim(), shops: $('aptShops').value.trim()};
  const old = editingApartment != null ? rack.apartments?.[editingApartment] : null;
  const cells = [...$('aptTable').querySelectorAll('.apt-line')].map(l => [l.children[0].value.trim(), parseInt(l.children[1].value, 10)]).filter(([u, c]) => u && c > 0);
  changeRack(rack.id, r => {
    r.apartments = r.apartments || [];
    if (editingApartment != null) r.apartments[editingApartment] = apartment; else r.apartments.push(apartment);
    // A renamed complex leaves its old name's pieces behind: they go too.
    const labels = old && old.name !== name ? assignApartment(r.labels, old.name, []) : r.labels;
    r.labels = assignApartment(labels, name, cells, cellCount(r));
  });
  showSorting(); showSettingsPage('apartments');
};
$('deleteApartment').onclick = () => {
  const rack = activeRack();
  if (!rack || editingApartment == null) return;
  changeRack(rack.id, r => { r.apartments.splice(editingApartment, 1); });
  showSorting(); showSettingsPage('apartments');
};

// ---- "업데이트": this web version, the newest Android app on GitHub and its download, the notes ----
let latestChecked = false;
async function checkLatestApp() {
  $('webVersion').textContent = APP_VERSION;
  if (latestChecked) return;
  try {
    const release = await (await fetch('https://api.github.com/repos/greatrima/roadnameconverter/releases/latest', {cache: 'no-store'})).json();
    const apk = (release.assets || []).find(a => a.name.endsWith('.apk'));
    $('latestAppVersion').textContent = release.tag_name || '확인 못 함';
    if (apk) $('downloadLatest').href = apk.browser_download_url;
    latestChecked = true;
  } catch { $('latestAppVersion').textContent = '확인 못 함'; }
}
$('copyAddress').onclick = () => copyText($('addressInput').value, '인식한 주소를 복사했습니다.');
$('copyResult').onclick = () => { if (mapAddress) { void copyText(mapAddress, '변환 주소를 복사했습니다.'); confirmUse(); } };
// The whole result is the copy target: easier than the small icon with one hand.
$('convertedText').onclick = () => $('copyResult').onclick();
$('mapButton').onclick = () => { openMap(); if (mapAddress) confirmUse(); };
// ---- settings: a list of rows; "›" rows open a page of the same dialog, ← (or Esc / back) returns to the list ----
let settingsPage = 'main', settingsBackTo = 'main';
function settingsValues() {
  const region = currentRegion();
  $('regionValue').textContent = (regionName(region) || '설정 안 됨') + (region.localities.length ? ` · ${region.localities.length}곳` : '');
  $('assistValue').textContent = memoryOn() ? '켜짐' : '꺼짐';
  $('offlineValue').textContent = flag(KEYS.offlineMode) ? '켜짐' : '꺼짐';
  $('memoryCount').textContent = `${memory.pairs.size + memory.names.size}개`;
  $('recentLimit').value = recentLimit() || '';
  $('recentMidnight').checked = flag(KEYS.recentMidnight);
  $('recentLines').value = recentLines();
  $('recentCount').textContent = `${recentEntries().length}개`;
  $('apartmentsValue').textContent = `${(activeRack()?.apartments || []).length}곳`;
  sortingValues();
  $('apiValue').textContent = store.get(KEYS.vworld) || store.get(KEYS.kakao) ? '개인 키' : store.get(KEYS.vworldDefault) ? '기본 키' : '설정 안 됨';
}
let mainScroll = 0;
function showSettingsPage(name) {
  const pages = [...document.querySelectorAll('#settingsDialog .settings-page')], page = pages.find(p => p.dataset.page === name) || pages[0];
  // Back to the list returns where it was; a page opened from it starts at the top.
  const from = settingsPage, to = page.dataset.page;
  if (from === 'main' && to !== 'main') mainScroll = $('settingsDialog').scrollTop;
  const scroll = to === from ? $('settingsDialog').scrollTop : to === 'main' ? mainScroll : 0;
  for (const p of pages) p.hidden = p !== page;
  settingsPage = page.dataset.page;
  const main = settingsPage === 'main';
  $('settingsTitle').textContent = page.dataset.title || '설정';
  settingsBackTo = page.dataset.back || 'main';
  $('settingsBack').hidden = main; $('settingsIcon').hidden = !main; $('appVersionBadge').hidden = !main;
  if (settingsPage === 'feedback') $('feedbackMessage').textContent = '';
  if (settingsPage === 'racks') renderRackList();
  if (settingsPage === 'rack') renderRack(true);
  if (settingsPage === 'assign') renderAssign();
  if (settingsPage === 'import') { $('importText').value = ''; $('importMessage').textContent = ''; }
  if (settingsPage === 'memoryList') renderMemoryList();
  if (settingsPage === 'recentPage') renderRecentPage();
  if (settingsPage === 'apartments') renderApartments();
  if (settingsPage === 'apartment') renderApartment();
  if (settingsPage === 'update') checkLatestApp();
  settingsValues();
  $('settingsDialog').scrollTop = scroll;
}
function openSettings(page = 'main') {
  $('vworldKey').value = store.get(KEYS.vworld); $('kakaoKey').value = store.get(KEYS.kakao); $('keyMessage').textContent = ''; $('dictionaryMessage').textContent = '';
  $('vworldKey').placeholder = store.get(KEYS.vworldDefault) ? '기본 키 사용 중' : '설정 안 됨';
  $('mapProvider').value = store.get(KEYS.map) || 'naver'; renderButtonSettings();
  showSettingsPage(page);
  $('settingsDialog').showModal(); void loadRegions();
}
for (const button of document.querySelectorAll('#settingsDialog [data-open]')) button.onclick = () => showSettingsPage(button.dataset.open);
$('settingsBack').onclick = () => showSettingsPage(settingsBackTo);
$('settingsDialog').addEventListener('cancel', e => { if (settingsPage !== 'main' && settingsPage !== 'assign') { e.preventDefault(); showSettingsPage(settingsBackTo); } });
$('settingsButton').onclick = () => openSettings(); $('regionButton').onclick = () => openSettings('region'); $('closeSettings').onclick = () => $('settingsDialog').close();
$('regionProvince').onchange = () => { renderCities(); saveRegion(); };
$('regionCity').onchange = () => { renderGus(); saveRegion(); };
$('regionGu').onchange = () => { renderLocalities(); saveRegion(); };
$('regionLocality').onchange = saveRegion;
$('saveKeys').onclick = () => {
  store.set(KEYS.vworld, $('vworldKey').value.trim()); store.set(KEYS.kakao, $('kakaoKey').value.trim());
  $('keyMessage').textContent = $('vworldKey').value.trim() ? '개인 VWorld 키를 저장했습니다.' : store.get(KEYS.vworldDefault) ? '기본 VWorld 키를 사용합니다.' : 'API 키를 저장했습니다.';
};
$('mapProvider').onchange = () => store.set(KEYS.map, $('mapProvider').value);
$('engine').value = store.get(KEYS.engine) || 'paddle'; $('engine').onchange = () => { store.set(KEYS.engine, $('engine').value); updateScanUi(); };
bindToggle('continuousScan', KEYS.continuous, () => { if (liveCamera() && !scanning && !selected) startScanning(); updateScanUi(); });
// The developer mode lasts one run (off at every launch); three quick taps on the version switch it.
store.set(KEYS.developer, '');
let versionTaps = [];
$('appVersionRow').onclick = () => {
  const now = Date.now();
  versionTaps = [...versionTaps.filter(t => now - t < 1500), now];
  if (versionTaps.length < 3) return;
  versionTaps = [];
  store.set(KEYS.developer, developerMode() ? '' : '1');
  $('cacheMessage').textContent = developerMode() ? '개발자 모드를 켰습니다.' : '개발자 모드를 껐습니다.';
  diag.render();
};
// Both alerts are on until switched off; a browser that cannot vibrate (iPhone) shows only the sound switch.
for (const [id, key] of [['alertVibration', KEYS.alertVibrationOff], ['alertSound', KEYS.alertSoundOff]]) {
  $(id).checked = !flag(key);
  $(id).onchange = () => store.set(key, $(id).checked ? '' : '1');
}
$('alertVibrationRow').hidden = !navigator.vibrate;
$('memoryToggle').checked = memoryOn();
$('memoryToggle').onchange = () => { store.set(KEYS.memoryOff, $('memoryToggle').checked ? '' : '1'); settingsValues(); };
$('clearMemory').onclick = () => { memory.clear(); store.set(KEYS.memory, ''); $('memoryMessage').textContent = '기억을 지웠습니다.'; };
// Keep the screen on while the app is in front (mail in the other hand); the browser releases it when hidden.
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
}
document.addEventListener('visibilitychange', keepAwake);
addEventListener('pointerdown', keepAwake, {passive: true});
void keepAwake();
// "의견 보내기" (a settings page): the text, a contact if the user leaves one and the app description go to the
// feedback form, nothing else. The open chat link sits under it.
const FEEDBACK_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSdc_SGkk0MCH3nE05VGCSXsT0bUU2O7EC75uylUyge7TiA1Cw/formResponse';
$('sendFeedback').onclick = async () => {
  const text = $('feedbackText').value.trim().slice(0, 1000), contact = $('feedbackContact').value.trim().slice(0, 100);
  if (!text) { $('feedbackMessage').textContent = '의견을 입력해 주세요.'; return; }
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const info = `도로명변환기 웹 ${APP_VERSION} · ${standalone ? '홈 화면 앱' : '브라우저'} · ${navigator.userAgent}`.slice(0, 300);
  $('sendFeedback').disabled = true;
  try {
    if (!online()) throw new Error('offline');
    // The form answers another site, so the reply cannot be read: an accepted request is taken as sent.
    const fields = {'entry.166744206': text, 'entry.187592757': info};
    if (contact) fields['entry.1726801074'] = contact;
    await fetch(FEEDBACK_FORM, {method: 'POST', mode: 'no-cors', body: new URLSearchParams(fields)});
    $('feedbackText').value = ''; $('feedbackContact').value = ''; $('settingsDialog').close(); setStatus('의견을 보냈습니다.');
  } catch { $('feedbackMessage').textContent = '보내지 못했습니다. 인터넷 연결을 확인해 주세요.'; }
  $('sendFeedback').disabled = false;
};
store.set(KEYS.offline, ''); // the manual offline mode was removed; never leave an old setting active
$('checkDictionary').onclick = () => updateDictionary(true);
// ---- "업데이트 내역": once on the first opening after an update (never on a first visit), and from the settings ----
function showWhatsNew() {
  const body = $('whatsNewBody');
  body.replaceChildren();
  let list = null;
  const inline = (parent, text) => text.split('**').forEach((part, i) => parent.append(i % 2 ? Object.assign(document.createElement('b'), {textContent: part}) : part));
  for (const line of WHATS_NEW.split('\n').map(l => l.trim())) {
    // A "##" title is the dialog's own; ">" lines are notes for the release page only.
    if (!line || line.startsWith('## ') || line.startsWith('>')) continue;
    if (line.startsWith('### ')) { list = null; body.append(Object.assign(document.createElement('h3'), {textContent: line.slice(4)})); continue; }
    if (line.startsWith('- ')) { list ??= body.appendChild(document.createElement('ul')); inline(list.appendChild(document.createElement('li')), line.slice(2)); continue; }
    list = null; inline(body.appendChild(document.createElement('p')), line);
  }
  $('whatsNewTitle').textContent = `v${APP_VERSION} 업데이트 내역`;
  $('whatsNewDialog').showModal();
}
$('whatsNewButton').hidden = !WHATS_NEW.trim();
$('whatsNewButton').onclick = () => { $('settingsDialog').close(); showWhatsNew(); };
$('closeWhatsNew').onclick = $('okWhatsNew').onclick = () => $('whatsNewDialog').close();
{
  // Before this existed nothing was recorded: a visitor who used the app before is no first visit.
  const seen = store.get(KEYS.seenVersion), returning = [KEYS.vworldDefault, KEYS.dictionaryChecked, KEYS.memory, KEYS.region].some(store.get);
  store.set(KEYS.seenVersion, APP_VERSION);
  if (WHATS_NEW.trim() && (seen ? seen !== APP_VERSION : returning)) showWhatsNew();
}

// ---- "순로구분": which rack cell a converted address goes into (대구분). Several racks may be kept (내 구역, a
// round covered for a colleague), one in use; each is named, exported as text and imported back (the app reads the
// same text). Same rules as the Android app, in sorting.mjs. Kept in this browser only. ----
let shownResult = null, lastCell = null, editingRack = null, editingCell = 1, rackResizing = false, rackGuideOpen = null, assignPieceText = null;
function sortingState() {
  try {
    const s = JSON.parse(store.get(KEYS.sorting) || '{}');
    return {enabled: !!s.enabled, active: s.active || null, changeSound: !!s.changeSound, racks: Array.isArray(s.racks) ? s.racks : []};
  } catch { return {enabled: false, active: null, changeSound: false, racks: []}; }
}
const saveSorting = state => store.set(KEYS.sorting, JSON.stringify(state));
const sortingOn = () => sortingState().enabled;
const activeRack = (state = sortingState()) => state.racks.find(r => r.id === state.active) || state.racks[0] || null;
function changeRack(id, change) { const state = sortingState(), rack = state.racks.find(r => r.id === id); if (rack) { change(rack); saveSorting(state); } }
/** A new rack, named; a name already used gets "(2)", so an imported rack never replaces one. */
function addRack(name, from = {}) {
  const state = sortingState(), base = String(name || '').trim() || `구분대 ${state.racks.length + 1}`;
  let unique = base;
  for (let n = 2; state.racks.some(r => r.name === unique); n++) unique = `${base} (${n})`;
  const rack = {columns: 0, rows: 0, labels: {}, priority: PRIORITY.ROAD, outside: null, ...from, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: unique};
  state.racks.push(rack); state.active = rack.id; saveSorting(state);
  return rack;
}
const roadForm = r => (r.recognizedKind === Kind.ROAD ? r.recognizedAddress : r.convertedAddress);
const parcelForm = r => (r.recognizedKind === Kind.ROAD ? r.convertedAddress : r.recognizedAddress);
const preferredForm = (r, rack) => (rack?.priority === PRIORITY.PARCEL ? parcelForm(r) : roadForm(r));
const cellTone = cell => (cell % 2 ? 'odd' : 'even');
function cellText(cell, tail = '') {
  return [document.createTextNode(String(cell)), Object.assign(document.createElement('small'), {textContent: `칸${tail}`})];
}

/**
 * The cell card over the converted address: "9칸" large in the cell's color (odd and even cells alternate, so
 * moving on to the next cell always changes the color). `fresh` (a letter just read): a cell other than the last
 * letter's deepens the card for a moment and the number pulses either way. Returns whether the cell changed.
 */
function showSorting(fresh = false) {
  const card = $('sortingCard'), cell = $('sortingCell'), assign = $('sortingAssign'), state = sortingState(), r = shownResult;
  $('appTitle').textContent = state.enabled ? `순로구분${activeRack(state) ? ` · ${activeRack(state).name}` : ''}` : '도로명변환기';
  if (!state.enabled || !r) { card.className = ''; cell.hidden = true; assign.hidden = true; return false; }
  const rack = activeRack(state);
  const verdict = rack ? locate(rack, roadForm(r), parcelForm(r), `${lastOcr?.text || ''}\n${$('addressInput').value}`) : {state: 'notConfigured'};
  cell.onclick = null;
  let tone;
  if (verdict.cell) {
    tone = cellTone(verdict.cell);
    cell.replaceChildren(...cellText(verdict.cell, verdict.outside ? ' 구역 밖' : ''));
    if (verdict.apartment) cell.append(Object.assign(document.createElement('span'), {className: 'cell-apartment', textContent: [verdict.apartment, verdict.unit].filter(Boolean).join(' ')}));
    cell.setAttribute('aria-label', `${verdict.cell}번 칸${verdict.outside ? ' (구역 밖)' : ''}`);
  } else {
    tone = {notMine: 'not-mine', unassigned: 'unassigned'}[verdict.state] || 'setup';
    cell.textContent = {notMine: '구역 아님', unassigned: '칸 미지정'}[verdict.state] || '구분대 설정 ›';
    cell.removeAttribute('aria-label');
    if (verdict.state === 'notConfigured') cell.onclick = () => { if (rack) { editingRack = rack.id; openSettings('rack'); } else openSettings('racks'); };
  }
  card.className = `sorting-card ${tone}${verdict.cell ? '' : ' state'}`;
  cell.hidden = false;
  assign.hidden = verdict.state === 'notConfigured' || (verdict.cell && !verdict.outside);
  if (!fresh || !verdict.cell) return false;
  const changed = lastCell !== null && lastCell !== verdict.cell, turned = lastCell !== verdict.cell;
  lastCell = verdict.cell;
  cell.classList.remove('pulse'); void cell.offsetWidth; cell.classList.add('pulse');
  if (turned) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  return changed;
}
$('sortingAssign').onclick = () => {
  const rack = activeRack(), text = shownResult && rack ? piece(preferredForm(shownResult, rack)) : null;
  if (!text) return;
  assignPieceText = text; openSettings('assign');
};

function sortingValues() {
  const state = sortingState(), rack = activeRack(state);
  $('sortingModeToggle').checked = state.enabled;
  $('rackValue').textContent = rack ? `${rack.name}${configured(rack) ? ` · ${rack.columns}×${rack.rows}` : ''}` : '설정 안 됨';
  $('rackListValue').textContent = `${state.racks.length}개`;
  $('sortingPriority').value = rack?.priority || PRIORITY.ROAD;
  $('sortingOutside').value = rack?.outside || '';
  $('sortingChangeSound').checked = state.changeSound;
}
$('sortingModeToggle').onchange = () => {
  const state = sortingState();
  state.enabled = $('sortingModeToggle').checked; saveSorting(state);
  showSorting();
  // Switched on without a rack: straight to making one.
  if (state.enabled && !activeRack()) { editingRack = addRack('내 구역').id; showSettingsPage('rack'); }
};
$('openImportFromSorting').onclick = () => showSettingsPage('import');
$('exportActiveRack').onclick = async () => {
  const rack = activeRack();
  if (!rack) { $('sortingExportMessage').textContent = '구분대가 없습니다.'; return; }
  const text = exportText(rack);
  try {
    if (navigator.share) await navigator.share({title: rack.name, text});
    else { await navigator.clipboard.writeText(text); $('sortingExportMessage').textContent = '복사했습니다. 메모나 카톡에 붙여 넣어 두세요.'; }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    try { await navigator.clipboard.writeText(text); $('sortingExportMessage').textContent = '복사했습니다.'; } catch { $('sortingExportMessage').textContent = '내보내지 못했습니다.'; }
  }
};
$('sortingPriority').onchange = () => { const rack = activeRack(); if (rack) changeRack(rack.id, r => { r.priority = $('sortingPriority').value; }); };
$('sortingOutside').onchange = () => {
  const rack = activeRack(), value = parseInt($('sortingOutside').value, 10);
  if (rack) changeRack(rack.id, r => { r.outside = value >= 1 && value <= cellCount(r) ? value : null; });
  sortingValues();
};
$('sortingChangeSound').onchange = () => { const state = sortingState(); state.changeSound = $('sortingChangeSound').checked; saveSorting(state); };

function renderRackList() {
  const state = sortingState(), active = activeRack(state);
  $('rackList').replaceChildren(...state.racks.map(rack => {
    const row = document.createElement('div'), pick = document.createElement('button'), edit = document.createElement('button');
    row.className = 'rack-row';
    pick.className = `rack-pick${rack === active ? ' active' : ''}`;
    pick.setAttribute('aria-pressed', String(rack === active));
    pick.append(rack.name, Object.assign(document.createElement('small'), {textContent: configured(rack) ? `${rack.columns}×${rack.rows} · ${filledCount(rack)}칸` : '크기 설정 전'}));
    pick.onclick = () => { const s2 = sortingState(); s2.active = rack.id; saveSorting(s2); renderRackList(); showSorting(); };
    edit.className = 'secondary'; edit.textContent = '편집';
    edit.setAttribute('aria-label', `${rack.name} 편집`);
    edit.onclick = () => { editingRack = rack.id; showSettingsPage('rack'); };
    row.append(pick, edit);
    return row;
  }));
}
$('newRack').onclick = () => { editingRack = addRack('').id; showSettingsPage('rack'); showSorting(); };
$('openImport').onclick = () => showSettingsPage('import');

const rackInEdit = () => sortingState().racks.find(r => r.id === editingRack) || null;
function renderRack(load) {
  const rack = rackInEdit();
  if (!rack) { showSettingsPage('racks'); return; }
  $('settingsTitle').textContent = rack.name;
  if (load) {
    $('rackName').value = rack.name; rackResizing = false; rackGuideOpen = null; editingCell = 1;
    $('rackColumns').value = rack.columns || ''; $('rackRows').value = rack.rows || '';
    $('rackSizeMessage').textContent = ''; $('exportMessage').textContent = ''; $('cellMessage').textContent = '';
  }
  const ok = configured(rack), filled = filledCount(rack), open = rackGuideOpen ?? filled === 0;
  $('rackSizeSummary').hidden = !ok || rackResizing; $('rackSizeRow').hidden = ok && !rackResizing;
  $('rackSizeText').textContent = ok ? `${rack.columns} × ${rack.rows}` : '';
  $('rackGuideBody').hidden = !open; $('rackGuideTitle').textContent = `적는 법${open ? '' : '  ›'}`;
  $('rackCells').hidden = !ok;
  if (!ok) return;
  editingCell = Math.min(Math.max(editingCell, 1), cellCount(rack));
  $('rackCount').textContent = `${cellCount(rack)}칸 중 ${filled}칸`;
  $('rackBar').style.width = `${Math.round(filled / cellCount(rack) * 100)}%`;
  renderGrid($('rackGrid'), rack, editingCell, chooseCell);
  $('cellEditor').className = `cell-editor ${cellTone(editingCell)}`;
  $('cellTitle').replaceChildren(...cellText(editingCell));
  $('cellTitle').setAttribute('aria-label', `${editingCell}번 칸`);
  $('cellLabel').setAttribute('aria-label', `${editingCell}번 칸 주소`);
  if (load || $('cellLabel').dataset.cell !== String(editingCell)) { $('cellLabel').value = rack.labels?.[editingCell] || ''; $('cellLabel').dataset.cell = String(editingCell); }
  $('cellPrevious').disabled = editingCell <= 1;
  renderChips();
}
/** Numbers only (a 6×6 rack leaves no room for text): cells with addresses in their color, the chosen one outlined. */
function renderGrid(grid, rack, chosen, choose) {
  grid.style.gridTemplateColumns = `repeat(${rack.columns}, minmax(0, 1fr))`;
  grid.replaceChildren(...Array.from({length: cellCount(rack)}, (_, i) => {
    const cell = i + 1, label = String(rack.labels?.[cell] || '').trim(), button = document.createElement('button');
    button.textContent = String(cell);
    button.className = [label ? cellTone(cell) : '', cell === chosen ? 'chosen' : ''].filter(Boolean).join(' ');
    button.style.setProperty('--cell-accent', cell % 2 ? '#23407A' : '#16794C');
    button.setAttribute('aria-label', `${cell}번 칸${label ? `, ${label}` : ''}`);
    button.onclick = () => choose(cell);
    return button;
  }));
}
function renderChips() {
  const {entries, problems, apartments} = parseRackLabel($('cellLabel').value, rackInEdit());
  $('cellChips').replaceChildren(...apartments.map(a => Object.assign(document.createElement('span'), {textContent: describeApartment(a)})),
    ...entries.map(e => Object.assign(document.createElement('span'), {textContent: describeEntry(e)})),
    ...problems.map(p => Object.assign(document.createElement('span'), {className: 'problem', textContent: `읽지 못함 · ${p}`})));
}
/** Saves the chosen cell's addresses; the same address written just as narrowly in another cell is told. */
function saveCell() {
  const rack = rackInEdit();
  if (!rack || !configured(rack)) return false;
  const text = $('cellLabel').value.trim(), cell = editingCell;
  const others = overlaps(rack, cell, text);
  changeRack(rack.id, r => { r.labels = r.labels || {}; if (text) r.labels[cell] = text; else delete r.labels[cell]; });
  $('cellMessage').textContent = others.length ? `${others.join(', ')}번 칸과 겹칩니다` : '';
  return true;
}
function chooseCell(cell) { if (cell === editingCell) return; saveCell(); editingCell = cell; renderRack(false); }
$('cellLabel').oninput = renderChips;
$('cellNext').onclick = () => {
  if (!saveCell()) return;
  const rack = rackInEdit();
  if (editingCell < cellCount(rack)) editingCell++; else $('cellMessage').textContent ||= '저장했습니다';
  renderRack(false);
};
$('cellPrevious').onclick = () => { if (saveCell() && editingCell > 1) { editingCell--; renderRack(false); } };
$('rackGuideTitle').onclick = () => { rackGuideOpen = $('rackGuideBody').hidden; renderRack(false); };
$('rackResize').onclick = () => { rackResizing = true; renderRack(false); };
$('rackApply').onclick = () => {
  const columns = parseInt($('rackColumns').value, 10), rows = parseInt($('rackRows').value, 10);
  if (!(columns >= 1 && columns <= 12 && rows >= 1 && rows <= 12)) { $('rackSizeMessage').textContent = '가로·세로는 1~12칸'; return; }
  changeRack(editingRack, r => { r.columns = columns; r.rows = rows; });
  rackResizing = false; $('rackSizeMessage').textContent = ''; renderRack(false); showSorting();
};
$('rackName').onchange = () => {
  const name = $('rackName').value.trim();
  if (name) changeRack(editingRack, r => { r.name = name; });
  $('settingsTitle').textContent = rackInEdit()?.name || ''; showSorting();
};
$('exportRack').onclick = async () => {
  saveCell();
  const text = exportText(rackInEdit());
  try {
    if (navigator.share) await navigator.share({title: rackInEdit().name, text});
    else { await navigator.clipboard.writeText(text); $('exportMessage').textContent = '복사했습니다. 메모나 카톡에 붙여 넣어 두세요.'; }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    try { await navigator.clipboard.writeText(text); $('exportMessage').textContent = '복사했습니다. 메모나 카톡에 붙여 넣어 두세요.'; } catch { $('exportMessage').textContent = '내보내지 못했습니다.'; }
  }
};
$('deleteRack').onclick = () => {
  const rack = rackInEdit();
  if (!rack || !confirm(`${rack.name}을(를) 지울까요?`)) return;
  const state = sortingState();
  state.racks = state.racks.filter(r => r.id !== rack.id);
  if (state.active === rack.id) state.active = state.racks[0]?.id || null;
  saveSorting(state); showSorting(); showSettingsPage('racks');
};
$('importText').oninput = () => {
  const read = importText($('importText').value);
  $('importMessage').textContent = !$('importText').value.trim() ? '' : !read ? '도로명변환기 구분대 글이 아닙니다.'
    : `${read.rack.name} · ${read.rack.columns}×${read.rack.rows} · ${filledCount(read.rack)}칸을 불러옵니다.${read.problems.length ? ` 읽지 못한 줄 ${read.problems.length}개` : ''}`;
};
$('importConfirm').onclick = () => {
  const read = importText($('importText').value);
  if (!read) { $('importMessage').textContent = '도로명변환기 구분대 글이 아닙니다.'; return; }
  addRack(read.rack.name, read.rack);
  showSorting(); showSettingsPage('racks');
};
function renderAssign() {
  const rack = activeRack();
  $('assignPiece').textContent = assignPieceText || '';
  if (!rack || !configured(rack)) { $('assignGrid').replaceChildren(); return; }
  renderGrid($('assignGrid'), rack, 0, cell => {
    changeRack(rack.id, r => { r.labels = r.labels || {}; const old = String(r.labels[cell] || '').trim(); r.labels[cell] = old ? `${old}, ${assignPieceText}` : assignPieceText; });
    $('settingsDialog').close(); showSorting(); setStatus(`${cell}칸에 추가했습니다`);
  });
}
showSorting();

// ---- "내 지역 주소 자료": the default region's 시·군·구 file (public road address data, served with the app), kept in
// this browser so its addresses convert without the address servers. Taken again when the region changes. ----
let localData = null;
const LOCAL_CACHE = 'roadname-local';
const localMeta = () => { try { return JSON.parse(store.get(KEYS.local) || 'null'); } catch { return null; } };
function localValues() {
  const meta = localMeta();
  // The district and the month of the data taken, chosen or found by itself alike.
  $('localDataValue').textContent = meta ? `${meta.district} · ${meta.version.slice(0, 4)}.${meta.version.slice(4)}` : '받기';
}
/**
 * No region chosen: the 시·군·구 most of the lately converted addresses are in (3 or more of the last 20 different
 * addresses) is taken by itself, and followed when the round moves. A chosen region always comes first.
 */
function noteDistrict(r) {
  let recent = [];
  try { recent = JSON.parse(store.get(KEYS.recent) || '[]'); } catch {}
  store.set(KEYS.recent, JSON.stringify(rememberDistrict(recent, r)));
  if (currentRegion().district) return;
  const found = autoDistrict(JSON.parse(store.get(KEYS.recent) || '[]')), meta = localMeta();
  if (found && !(meta && meta.district === found.district && meta.province === found.province)) void downloadLocalData(true, found, true);
}
async function loadLocalData() {
  const meta = localMeta();
  if (!meta) return;
  try {
    // One district, or every 구 of a whole 시 ("41271+41273") joined.
    const cache = await caches.open(LOCAL_CACHE), texts = [];
    for (const code of meta.code.split('+')) {
      const saved = await cache.match(`./local/${code}.tsv.gz`);
      if (!saved) return;
      texts.push(await gunzipText(new Uint8Array(await saved.arrayBuffer())));
    }
    localData = parseLocal(mergeLocal(texts));
  } catch { localData = null; }
}
/** Takes the default region's district file; `quiet` (a region change) tells nothing unless it fails. */
async function downloadLocalData(quiet = false, chosen = null, auto = false) {
  let region = chosen || currentRegion();
  // Without a chosen region the button takes the region found from the converted addresses, if any.
  if (!region.district && !chosen) { try { const found = autoDistrict(JSON.parse(store.get(KEYS.recent) || '[]')); if (found) { region = found; auto = true; } } catch {} }
  if (!region.province || !region.district) { askRegion(); return; }
  if (!navigator.onLine) { $('localMessage').textContent = '인터넷 연결이 필요합니다.'; return; }
  if (!quiet) $('localMessage').textContent = '받는 중…';
  try {
    const index = await (await fetch('./local/index.json', {cache: 'no-store'})).json();
    const entries = localEntries(index.districts, region);
    if (!entries.length) { $('localMessage').textContent = '이 지역 자료가 없습니다.'; return; }
    const code = entries.map(e => e.code).join('+');
    const name = entries.length === 1 && entries[0].district ? entries[0].district : region.district;
    const meta = localMeta();
    if (meta?.code === code && meta.version === index.version && localData) {
      if (!!meta.auto !== auto) { store.set(KEYS.local, JSON.stringify({...meta, auto})); localValues(); }
      if (!quiet) $('localMessage').textContent = '최신 자료입니다.';
      return;
    }
    const responses = [], texts = [];
    for (const e of entries) {
      const response = await fetch(`./local/${e.code}.tsv.gz`, {cache: 'no-store'});
      if (!response.ok) throw new Error(String(response.status));
      texts.push(await gunzipText(new Uint8Array(await response.clone().arrayBuffer())));
      responses.push([e.code, response]);
    }
    const data = parseLocal(mergeLocal(texts));
    if (!data) throw new Error('format');
    const cache = await caches.open(LOCAL_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    for (const [c, response] of responses) await cache.put(`./local/${c}.tsv.gz`, response);
    store.set(KEYS.local, JSON.stringify({code, version: index.version, province: region.province, district: name, auto}));
    localData = data;
    $('localMessage').textContent = `${name} 자료를 받았습니다. 이 지역 주소는 인터넷 없이 변환됩니다.`;
  } catch { $('localMessage').textContent = '받지 못했습니다. 잠시 뒤 다시 눌러 주세요.'; }
  localValues();
}
/** A region to take the data of: the chosen one, or the one found from the converted addresses. */
function hasRegion() {
  if (currentRegion().district || localMeta()?.auto) return true;
  try { return !!autoDistrict(JSON.parse(store.get(KEYS.recent) || '[]')); } catch { return false; }
}
function askRegion() { if (confirm('우선 인식 지역을 먼저 정해 주세요.')) showSettingsPage('region'); }
$('offlineMode').checked = flag(KEYS.offlineMode);
$('offlineMode').onchange = () => {
  if ($('offlineMode').checked && !hasRegion()) { $('offlineMode').checked = false; askRegion(); return; }
  store.set(KEYS.offlineMode, $('offlineMode').checked ? '1' : '');
  network();
};
$('localDataButton').onclick = () => downloadLocalData();
void loadLocalData().then(localValues);

// ---- keyboard: some iPhones (home-screen app) do not shrink the page for the keyboard, so the box being edited
// could stay behind it. While the keyboard is up the app and its dialogs take the visible height only, and the
// box is scrolled into the middle of it. ----
if (window.visualViewport) {
  const view = window.visualViewport, root = document.documentElement;
  const editable = el => el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file', 'range'].includes(el.type));
  let frame = 0;
  const fit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const keyboard = innerHeight - view.height > 120 && editable(document.activeElement);
      root.classList.toggle('keyboard', keyboard);
      if (!keyboard) { root.style.removeProperty('--visible-height'); root.style.removeProperty('--visible-top'); return; }
      root.style.setProperty('--visible-height', `${Math.round(view.height)}px`);
      root.style.setProperty('--visible-top', `${Math.round(view.offsetTop)}px`);
      const box = document.activeElement.getBoundingClientRect();
      if (box.top < view.offsetTop + 8 || box.bottom > view.offsetTop + view.height - 8) document.activeElement.scrollIntoView({block: 'center'});
    });
  };
  view.addEventListener('resize', fit);
  view.addEventListener('scroll', fit);
  document.addEventListener('focusin', () => setTimeout(fit, 300));
  document.addEventListener('focusout', () => setTimeout(fit, 300));
}
// iPhone Safari has no install prompt: show a one-line hint until closed; never inside the home-screen app.
{
  const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !store.get(KEYS.installHint)) {
    if (/KAKAOTALK|NAVER\(|Instagram|FBAN|FBAV|Line\//.test(navigator.userAgent)) $('installText').textContent = 'Safari로 열어야 홈 화면에 추가할 수 있어요';
    $('installHint').hidden = false;
    $('closeInstallHint').onclick = () => { $('installHint').hidden = true; store.set(KEYS.installHint, '1'); };
  }
}
// The camera stops in the background (battery) and comes back by itself, e.g. after opening a map app.
let resumeCamera = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (stream) { resumeCamera = true; stopCamera(); $('empty').hidden = hasPhoto; setBusy(busy); } }
  else if (resumeCamera) { resumeCamera = false; if (!stream && !hasPhoto && !busy) void openCamera(); }
});
window.addEventListener('pagehide', () => { stopCamera(); cancel(); });
function network() {
  $('offlineState').textContent = navigator.onLine ? '온라인' : '오프라인';
  if (!online() && converting) { requestSeq++; setConverting(false); showLocalResult(true); }
  else if (awaitingNetwork) setStatus(online() ? '인터넷이 연결되었습니다. ‘주소 변환’을 눌러 선택한 주소를 확인·변환하세요.' : '오프라인 · 인터넷 연결 후 ‘주소 변환’을 눌러주세요.');
  else if (!online() && !$('statusText').textContent) setStatus(offlineStatus());
  else if (online() && /^오프라인/.test($('statusText').textContent)) setStatus('');
}
window.addEventListener('online', () => { network(); void loadDefaultKey(); }); window.addEventListener('offline', network);
applyButtonVisibility(); showRegion(); clearAddressState(); network(); void loadDefaultKey(); updateScanUi();
// Load the dictionary in the background; the first Android launch also checks for a newer one once.
void loadDictionary().then(() => { if (!flag(KEYS.dictionaryChecked)) void updateDictionary(false); }).catch(() => {});
// Start the camera on launch. iOS home-screen apps do not remember the permission, so iOS may ask
// each launch; one "허용" tap is then all that is needed. Only an explicit denial keeps the button.
Promise.resolve(navigator.permissions?.query?.({name: 'camera'})).catch(() => null)
  .then(p => { if (p?.state !== 'denied' && !stream && !hasPhoto) void openCamera(); });

// ---- offline readiness (required files only; Tesseract is cached when first used) ----
const CACHE = 'roadname-assets-v15'; let swReady = null, cacheReady = false, updateReady = false;
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
if ('serviceWorker' in navigator) swReady = navigator.serviceWorker.register('./sw.js').then(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))])).catch(() => { $('cacheMessage').textContent = '오프라인 준비를 사용할 수 없습니다. 온라인 인식은 가능합니다.'; return null; });
async function cacheFiles() { const res = await fetch('./cache-list.json'); if (!res.ok) throw new Error('파일 목록을 읽을 수 없습니다.'); return res.json(); }
function showBadge(text, state) { if (updateReady && state !== 'update') return; const b = $('offlineBadge'); b.hidden = false; b.textContent = text; b.dataset.state = state; }
// A new deploy activated while this page was open: offer a one-tap reload instead of running mixed versions.
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  navigator.serviceWorker.addEventListener('controllerchange', () => { showBadge('새 버전 · 눌러서 적용', 'update'); updateReady = true; });
}
async function checkCache() {
  if (!('caches' in window) || !('serviceWorker' in navigator) || cacheBusy) return;
  try {
    const {required} = await cacheFiles(), cache = await caches.open(CACHE); let found = 0;
    for (const url of required) if (await cache.match(url)) found++;
    cacheReady = found === required.length;
    if (cacheReady) { showBadge('오프라인 준비됨', 'ready'); $('cacheMessage').textContent = '오프라인 준비 완료'; }
    else showBadge(`오프라인 준비 ${found}/${required.length}`, 'pending');
  } catch {}
}
async function prepare() {
  if (busy || cacheBusy) return; cacheBusy = true; setBusy(false); error('');
  try {
    const reg = await swReady; if (!reg) throw new Error('Safari에서 이 페이지를 열어 다시 시도해주세요.');
    const {required, optional = []} = await cacheFiles(), cache = await caches.open(CACHE); let done = 0;
    for (const url of required) {
      showBadge(`받는 중 ${++done}/${required.length}`, 'busy'); $('cacheMessage').textContent = `오프라인 준비 중 ${done}/${required.length} · 약 32 MB`;
      if (!await cache.match(url)) {
        const res = await fetch(url, {cache: 'reload', signal: AbortSignal.timeout(120000)});
        if (!res.ok || res.type === 'opaque' || new URL(res.url).origin !== location.origin) throw new Error('파일 다운로드에 실패했습니다. 인터넷 연결을 확인해주세요.');
        await cache.put(url, res);
      }
    }
    for (const url of optional) { try { if (!await cache.match(url)) { const res = await fetch(url); if (res.ok) await cache.put(url, res); } } catch {} }
    await navigator.storage?.persist?.();
  } catch (e) { $('cacheMessage').textContent = '준비가 중단되었습니다. 다시 누르면 이어서 받습니다.'; error(e.message); }
  finally { cacheBusy = false; setBusy(false); await checkCache(); if (liveCamera() && !scanning && !selected) startScanning(); }
}
$('offlineBadge').onclick = () => { if (updateReady) location.reload(); else if (!cacheReady) void prepare(); };
void (async () => {
  await swReady; await checkCache();
  // Home-screen apps keep their own storage on iOS, so download once inside the installed app.
  if (!cacheReady && standalone() && navigator.onLine) setTimeout(() => { if (!cacheReady) void prepare(); }, 1500);
})();

// Optional WebMCP support uses the same UI action and transient result state.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController(); window.addEventListener('pagehide', () => lifecycle.abort(), {once: true});
  Promise.resolve(document.modelContext.registerTool({name: 'read_ocr_results', title: '인식 결과 읽기', description: '현재 사진의 OCR 결과와 주소 변환 결과를 읽습니다. 사진을 촬영하거나 인식을 시작하지 않습니다.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}, annotations: {readOnlyHint: true, untrustedContentHint: true}, execute(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('빈 객체만 입력할 수 있습니다.');
    return {busy, address: $('addressInput').value, converted: mapAddress, results: [...$('results').querySelectorAll('article')].map(e => ({engine: e.querySelector('h2').textContent, text: e.querySelector('textarea').value}))};
  }}, {signal: lifecycle.signal})).catch(() => {});
}
showRecent();

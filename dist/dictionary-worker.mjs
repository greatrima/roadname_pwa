// Dictionary worker: loads the Android address dictionary once, off the UI thread,
// and answers correction/suggestion requests. Updates come from the Android repository.
import {AddressDictionary, AddressCandidateEngine, validateDictionaryText, isOlderVersion} from './address-dictionary.mjs';
import {localitySuggestions} from './address-suggest.mjs';
import {candidate as makeCandidate, parseParts} from './address-core.mjs';

const BUNDLED = './models/address_dictionary.tsv.gz';
const BUNDLED_VERSION = './models/dictionary-version.json';
const UPDATE_CACHE = 'roadname-dictionary';
const UPDATE_FILE = './dictionary-update.tsv.gz', UPDATE_META = './dictionary-update.json';
const RELEASES = 'https://api.github.com/repos/greatrima/roadnameconverter/releases/latest';
const RAW = 'https://raw.githubusercontent.com/greatrima/roadnameconverter/main/app/src/main/assets/address_dictionary.tsv.gz';

let dictionary = null, engine = null, tree = null, digest = '', loading = null;

async function decodeBytes(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function install(text) {
  dictionary = AddressDictionary.parse(text);
  engine = new AddressCandidateEngine(dictionary);
  tree = dictionary.localityTree();
  digest = await sha256(text);
}

async function load() {
  // A downloaded update is used only when it is newer than the dictionary shipped with this deploy.
  try {
    const cache = await caches.open(UPDATE_CACHE);
    const [meta, update] = await Promise.all([cache.match(UPDATE_META), cache.match(UPDATE_FILE)]);
    if (meta && update) {
      const {version} = await meta.json();
      let bundledVersion = '';
      try { bundledVersion = (await (await fetch(BUNDLED_VERSION)).json()).version || ''; } catch {}
      if (!bundledVersion || isOlderVersion(bundledVersion, version)) {
        await install(await decodeBytes(new Uint8Array(await update.arrayBuffer())));
        return;
      }
    }
  } catch { dictionary = null; }
  const response = await fetch(BUNDLED);
  if (!response.ok) throw new Error('내장 주소 사전을 불러오지 못했습니다.');
  await install(await decodeBytes(new Uint8Array(await response.arrayBuffer())));
}
const ready = () => (loading ??= load().catch(error => { loading = null; throw error; }));

function localityCandidates(raw, region) {
  const selected = region.province && region.district ? `${region.province}|${region.district}` : '';
  const out = [];
  for (const c of raw) {
    for (const entry of localitySuggestions(c.text, tree, selected)) {
      for (const item of entry.items) {
        let text = c.text.slice(0, entry.start) + item.name + c.text.slice(entry.start + entry.original.length);
        const parts = parseParts(text);
        if (parts && !parts.prefix.some(t => /(?:시|군|구)$/.test(t))) {
          // Several regions share locality names; show the dictionary's region instead of guessing.
          const number = parts.number != null ? ` ${parts.mountain ? '산 ' : ''}${parts.number}` : '';
          text = [item.province, item.district, ...parts.prefix.filter(t => /(?:읍|면)$/.test(t)), parts.name].join(' ') + number;
        }
        out.push(makeCandidate(text, c.kind, {completeness: c.completeness, details: c.details, manualOnly: true, dictionaryCorrected: true,
          confidence: 60, reviewReason: '사전 후보', hint: `${entry.original} → ${item.name}`}));
      }
    }
  }
  return out;
}

async function checkUpdate() {
  await ready();
  let response = null;
  try {
    const release = await fetch(RELEASES, {headers: {Accept: 'application/vnd.github+json'}, cache: 'no-store'});
    if (release.ok) {
      const asset = ((await release.json()).assets || []).find(a => a.name?.startsWith('address_dictionary') && a.name.endsWith('.tsv.gz'));
      if (asset) { try { const r = await fetch(asset.browser_download_url); if (r.ok) response = r; } catch {} }
    }
  } catch {}
  if (!response) {
    response = await fetch(RAW, {cache: 'no-store'});
    if (!response.ok) throw new Error(`사전 다운로드 응답 코드 ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1024 || bytes.length > 20_000_000) throw new Error('사전 파일 크기가 올바르지 않습니다.');
  const text = await decodeBytes(bytes);
  const version = validateDictionaryText(text);
  if (isOlderVersion(version, dictionary.version) || await sha256(text) === digest) return {status: 'upToDate', version: dictionary.version};
  await install(text);
  const cache = await caches.open(UPDATE_CACHE);
  await cache.put(UPDATE_FILE, new Response(bytes));
  await cache.put(UPDATE_META, new Response(JSON.stringify({version})));
  return {status: 'updated', version, tree};
}

self.onmessage = async ({data}) => {
  const {id, type} = data;
  try {
    let result;
    if (type === 'init') { await ready(); result = {version: dictionary.version, tree}; }
    else if (type === 'candidates') {
      await ready();
      const region = data.region || {};
      const corrected = (data.blocks || []).flatMap(block => engine.candidates([block], region)).map(c => ({...c, manualOnly: true}));
      // Region-aware sound-alike locality suggestions first (눈극동 → 눤곡동), then the Android engine's corrections.
      result = [...localityCandidates(data.raw || [], region), ...corrected];
    } else if (type === 'names') {
      // Setting "내 수정 기억": which of these words are real names (a real name is never learned as a misreading).
      await ready();
      result = (data.names || []).map(name => dictionary.isExactAddressName(name));
    } else if (type === 'update') result = await checkUpdate();
    else throw new Error(`unknown ${type}`);
    postMessage({id, result});
  } catch (error) { postMessage({id, error: error?.message || String(error)}); }
};

// Setting "내 수정 기억" (port of the Android AddressMemory): what the user confirmed by hand, kept on the device only.
//
// - Names of confirmed addresses with how often they were used; remembered names are offered first.
// - Misread words with the name the user typed instead ("누저4긱" → "누정4길"); the next reading of that word is
//   replaced before the address is looked for.
//
// Only names are kept: never a building number, a unit, a recipient or the OCR text. A misread word is learned only
// when it is no real name itself, is replaced only with its number after it, and the number is left as read.

export const MAX_NAMES = 200, MAX_PAIRS = 200;
const MAX_COUNT = 9999;
const DASHES = /[‐‑‒–—−﹣－]/g;
// A Hangul word ending in Hangul (digits allowed inside, as in 누정4길), then optionally '산' and a base number that
// is not part of a phone number or a 동/층/호 detail. Groups: 1 word, 2 '산', 3 number.
const nameWord = () => /([가-힣][가-힣0-9]{0,13}[가-힣])(?:[ \t]*(산)[ \t]*(?=\d))?(?:[ \t]*(\d{1,5}(?:[ \t]*-[ \t]*\d{1,5})?)(?![\d-]|[ \t]*-|[ \t]*(?:동|층|호)))?/g;

const key = word => word.replace(/\s/g, '');
const valid = word => word.length >= 2 && word.length <= 40 && !/[\t\n\r]/.test(word);
const digits = word => (word.match(/\d+/g) || []).join(',');

/** Initial, medial and final letters of every Hangul syllable; other characters as they are. */
export function jamo(text) {
  let out = '';
  for (const ch of text) {
    const index = ch.charCodeAt(0) - 0xAC00;
    if (index < 0 || index >= 11172) { out += ch; continue; }
    const final = index % 28;
    out += String.fromCharCode(0x1100 + Math.floor(index / 588), 0x1161 + Math.floor(index / 28) % 21);
    if (final) out += String.fromCharCode(0x11A7 + final);
  }
  return out;
}

/** Edit distance, stopping at limit + 1. */
export function distance(left, right, limit = Infinity) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({length: right.length + 1}, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (current[j] < best) best = current[j];
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

/** Words of the OCR source that have a base number after them (the ones that can be a misread name). */
export function numberedWords(source) {
  const words = new Set();
  for (const match of source.replace(DASHES, '-').matchAll(nameWord())) if (match[3] != null) words.add(match[1]);
  return [...words];
}

export class AddressMemory {
  constructor(serialized = '') {
    // Insertion order = use order: the first entry is the one unused for the longest time.
    this.names = new Map();
    this.pairs = new Map();
    for (const line of serialized.split('\n')) {
      const fields = line.split('\t');
      if (fields.length !== 3) continue;
      if (fields[0] === 'N') { const count = /^\d+$/.test(fields[2]) ? Number(fields[2]) : 0; if (valid(fields[1]) && count > 0) this.names.set(fields[1], count); }
      else if (fields[0] === 'P' && valid(fields[1]) && valid(fields[2])) this.pairs.set(fields[1], fields[2]);
    }
  }

  get isEmpty() { return !this.names.size && !this.pairs.size; }

  /** How often the user confirmed an address with this road or 동·리 name; 0 when never. */
  weight(name) { return this.names.get(key(name)) || 0; }

  rememberName(name) {
    const k = key(name);
    if (!valid(k)) return;
    const count = Math.min((this.names.get(k) || 0) + 1, MAX_COUNT);
    this.names.delete(k); this.names.set(k, count);
    if (this.names.size > MAX_NAMES) this.names.delete(this.names.keys().next().value);
  }

  /** The name the user typed for this misread word, or null. */
  correction(word) { return this.pairs.get(key(word)) ?? null; }

  learn(misread, corrected) {
    const k = key(misread);
    if (!valid(k) || !valid(corrected) || k === key(corrected)) return;
    this.pairs.delete(k); this.pairs.set(k, corrected);
    if (this.pairs.size > MAX_PAIRS) this.pairs.delete(this.pairs.keys().next().value);
  }

  forget(misread) { this.pairs.delete(key(misread)); }

  clear() { this.names.clear(); this.pairs.clear(); }

  /** The text with every learned misreading that has its number after it replaced; the number stays as read. */
  apply(text) {
    const applied = [];
    if (!this.pairs.size) return {text, applied};
    const replaced = text.replace(nameWord(), (whole, word, _mountain, number) => {
      const corrected = number == null ? null : this.correction(word);
      if (corrected == null) return whole;
      applied.push({misread: word, corrected});
      return corrected + whole.slice(word.length);
    });
    return {text: replaced, applied};
  }

  /**
   * After the user confirmed `name` with `number`: the word the OCR source has before that same number is learned as
   * its misreading, when it is no real name, shares the name's digits and is close enough to be the same word. A
   * correction remembered for a word before that number is dropped when it names another address than the one just
   * confirmed. Returns the learned word or null.
   */
  learnFromSource(source, name, number, isRealName) {
    const wanted = String(number).replace(/\s/g, '');
    if (!wanted || !valid(name)) return null;
    const target = jamo(name), limit = Math.floor(target.length / 2);
    let best = null, bestDistance = Infinity;
    for (const match of source.replace(DASHES, '-').matchAll(nameWord())) {
      const word = match[1], read = match[3]?.replace(/\s/g, '');
      if (read !== wanted || word === name) continue;
      const remembered = this.correction(word);
      if (remembered != null && remembered !== name) this.forget(word);
      if (isRealName(word) || digits(word) !== digits(name)) continue;
      const d = distance(jamo(word), target, limit);
      if (d >= 1 && d <= limit && d < bestDistance) { best = word; bestDistance = d; }
    }
    if (best != null) this.learn(best, name);
    return best;
  }

  serialize() {
    let out = '';
    for (const [name, count] of this.names) out += `N\t${name}\t${count}\n`;
    for (const [misread, corrected] of this.pairs) out += `P\t${misread}\t${corrected}\n`;
    return out;
  }
}

// "주소 메모": what the user wrote for an address ("어쩌리 166" → "어쩌로 60-1 앞 밭"), for places the servers do not
// know or that need a word more. Found by the address's name and number whatever region words come before it.
// Kept in this browser only. Same keys and text format as the Android AddressNotes.
import {parseParts} from './address-core.mjs';

export const MAX_NOTES = 2000, MAX_TEXT = 200;

/** "PARCEL|어쩌리|166": the kind, the name without spaces, 산 and the number; null without a number. */
export function noteKey(address) {
  const parts = parseParts(String(address || '').trim());
  const number = parts?.number?.replace(/\s/g, '');
  if (!number) return null;
  return [parts.kind, parts.name.replace(/\s/g, ''), (parts.mountain ? '산' : '') + number].join('|');
}

const escape = text => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
const unescape = text => text.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

export class AddressNotes {
  constructor(serialized = '') {
    this.notes = new Map();
    for (const line of String(serialized).split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const text = unescape(line.slice(tab + 1)).trim();
      if (text) this.notes.set(line.slice(0, tab), text.slice(0, MAX_TEXT));
    }
  }
  get size() { return this.notes.size; }
  /** The note of the first of `addresses` that has one. */
  find(...addresses) {
    for (const address of addresses) {
      const key = address ? noteKey(address) : null;
      if (key && this.notes.has(key)) return this.notes.get(key);
    }
    return null;
  }
  /** Keeps `text` for `address` (an empty text removes it); false when `address` has no number. */
  put(address, text) {
    const key = noteKey(address);
    if (!key) return false;
    const note = String(text || '').trim().slice(0, MAX_TEXT);
    this.notes.delete(key);
    if (note) {
      this.notes.set(key, note);
      while (this.notes.size > MAX_NOTES) this.notes.delete(this.notes.keys().next().value);
    }
    return true;
  }
  serialize() { return [...this.notes].map(([key, text]) => `${key}\t${escape(text)}`).join('\n'); }
}

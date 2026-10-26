// "최근 주소" (setting in 인식 보조, off unless a count is typed; same rules as the app's RecentAddressStore): the
// addresses converted lately, newest first, shown under the empty input to convert again with one tap. Each address
// once (used again, it moves to the top), at most `limit`; with "매일 자정" the ones of an earlier day are gone.

const key = text => String(text || '').replace(/\s+/g, '').replace(/[‐-―－]/g, '-').toLowerCase();
const day = time => new Date(time).toDateString();

/** The kept entries ({recognized, converted, at}) to show: none while off, only today's with `midnight`. */
export function visibleRecent(list, limit, midnight, now = Date.now()) {
  if (!(limit > 0)) return [];
  return (list || []).filter(e => !midnight || day(e.at) === day(now)).slice(0, limit);
}

/** `list` with a converted address added at the top. */
export function addRecent(list, result, limit, midnight, now = Date.now()) {
  if (!(limit > 0) || !result?.recognizedAddress) return list || [];
  const k = key(result.recognizedAddress);
  const kept = visibleRecent(list, limit, midnight, now).filter(e => key(e.recognized) !== k);
  return [{recognized: result.recognizedAddress, converted: result.convertedAddress || '', at: now}, ...kept].slice(0, limit);
}

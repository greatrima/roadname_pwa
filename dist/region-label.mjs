// The header's region line: "전남광주 나주시 봉황면". 시·도 by their official short names; when the line does not fit,
// the 시·도 is left out ("나주시 봉황면").

const SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주', 대전광역시: '대전',
  울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북',
  충청남도: '충남', 전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
  제주특별자치도: '제주', 전남광주통합특별시: '전남광주',
};

/** "전라남도" → "전남"; an unknown name loses its ending ("우편특별시" → "우편"). */
export function provinceShort(name) {
  const value = String(name || '').trim();
  return SHORT[value] || value.replace(/(?:통합특별시|특별자치도|특별자치시|광역시|특별시|도)$/, '') || value;
}

/**
 * The region as one short line, or '' when none is set. One chosen 동·읍·면 is named, more are counted
 * ("봉황면 외 2"). `compact` leaves the 시·도 out unless it is all there is.
 */
export function regionLine(region, compact = false) {
  const province = region?.province ? provinceShort(region.province) : '';
  const district = String(region?.district || '').trim();
  const localities = Array.isArray(region?.localities) ? region.localities.filter(Boolean) : [];
  if (!province && !district) return '';
  const place = localities.length === 1 ? localities[0] : localities.length > 1 ? `${localities[0]} 외 ${localities.length - 1}` : '';
  return [compact && district ? '' : province, district, district ? place : ''].filter(Boolean).join(' ');
}

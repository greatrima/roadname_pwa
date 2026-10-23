"""Road address <-> parcel data per 시·군·구, for lookups without the address servers ("내 지역 주소 자료").

Source: the Ministry of the Interior and Safety's monthly "도로명주소 한글" full data (business.juso.go.kr,
주소정보 다운로드), public data. One file per district keeps a phone's download small (about 135 KB):

    # address-lens-local-v1
    # version=202609
    # district=경기도 수원시 장안구
    R	<road name>             one line per road, numbered from 0 in order
    L	<읍면동[ 리]>           one line per locality, numbered from 0 in order
    B	<road>	<number>	<locality>	<parcel>	<more parcels>
                               number: 50, 12-3 or u396 (지하); parcel: 127, 12-3, 산12
                               more parcels: "<locality>:<parcel>" joined by ';' (관련지번)

Usage:
    python scripts/local-data.py build RNADDR_KOR_2609.zip out/      -> out/local/<code>.tsv.gz + index.json + local-data.zip
"""
import gzip
import hashlib
import io
import json
import pathlib
import sys
import zipfile
from collections import defaultdict

HEADER = '# address-lens-local-v1'


def number(main, sub):
    return main + (f'-{sub}' if sub not in ('', '0') else '')


def parcel(mountain, main, sub):
    return ('산' if mountain == '1' else '') + number(main, sub)


def locality(dong, ri):
    return (dong + (' ' + ri if ri else '')).strip()


def build(source, out):
    version = '20' + ''.join(ch for ch in pathlib.Path(source).stem if ch.isdigit())[-4:]
    archive = zipfile.ZipFile(source)
    names = [i.filename for i in archive.infolist()]
    districts = defaultdict(dict)
    titles = {}
    for name in names:
        if not name.startswith('rnaddrkor_'):
            continue
        with archive.open(name) as f:
            for raw in io.TextIOWrapper(f, encoding='cp949', errors='replace'):
                c = raw.rstrip('\r\n').split('|')
                if len(c) < 14 or not c[10] or not c[12]:
                    continue
                code = c[1][:5]
                titles[code] = (c[2], c[3])
                districts[code][c[0]] = [c[10], ('u' if c[11] == '1' else '') + number(c[12], c[13]), locality(c[4], c[5]),
                                         parcel(c[6], c[7], c[8]), []]
    for name in names:
        if not name.startswith('jibun_rnaddrkor_'):
            continue
        with archive.open(name) as f:
            for raw in io.TextIOWrapper(f, encoding='cp949', errors='replace'):
                c = raw.rstrip('\r\n').split('|')
                if len(c) < 9:
                    continue
                row = districts.get(c[1][:5], {}).get(c[0])
                if row is not None:
                    row[4].append((locality(c[4], c[5]), parcel(c[6], c[7], c[8])))

    local = pathlib.Path(out) / 'local'
    local.mkdir(parents=True, exist_ok=True)
    index = []
    for code in sorted(districts):
        province, district = titles[code]
        roads, localities, lines = {}, {}, []
        for road, num, loc, main_parcel, more in districts[code].values():
            r = roads.setdefault(road, len(roads))
            l_index = localities.setdefault(loc, len(localities))
            extra = ';'.join(f'{localities.setdefault(m[0], len(localities))}:{m[1]}' for m in more if m != (loc, main_parcel))
            lines.append(f'B\t{r}\t{num}\t{l_index}\t{main_parcel}\t{extra}')
        text = '\n'.join([HEADER, f'# version={version}', f'# district={province} {district}'.strip(),
                          *(f'R\t{n}' for n in roads), *(f'L\t{n}' for n in localities), *lines]) + '\n'
        data = gzip.compress(text.encode('utf-8'), 9, mtime=0)
        (local / f'{code}.tsv.gz').write_bytes(data)
        index.append({'code': code, 'province': province, 'district': district, 'rows': len(lines), 'bytes': len(data),
                      'sha256': hashlib.sha256(data).hexdigest()})
    (local / 'index.json').write_text(json.dumps({'version': version, 'districts': index}, ensure_ascii=False, indent=0), encoding='utf-8')
    bundle = pathlib.Path(out) / 'local-data.zip'
    with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_STORED) as z:
        for path in sorted(local.iterdir()):
            z.write(path, f'local/{path.name}')
    print(f'{version}: {len(index)} districts, {sum(d["rows"] for d in index)} rows, {bundle.stat().st_size / 1e6:.1f} MB')


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != 'build':
        sys.exit(__doc__)
    build(sys.argv[2], sys.argv[3])
